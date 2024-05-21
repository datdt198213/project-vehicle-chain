"use strict";

const crypto = require("crypto"),
  SHA256 = (message) =>
    crypto.createHash("sha256").update(message).digest("hex");
const WS = require("ws");
const EC = require("elliptic").ec,
  ec = new EC("secp256k1");
const {Level} = require("level");
const {fork} = require("child_process");

const Block = require("../core/block");
const Transaction = require("../core/transaction");
const changeState = require("../core/state");
const {
  BLOCK_REWARD,
  BLOCK_GAS_LIMIT,
  EMPTY_HASH,
  INITIAL_SUPPLY,
  FIRST_ACCOUNT,
} = require("../config.json");
const {produceMessage, sendMessage} = require("./message");
const generateGenesisBlock = require("../core/genesis");
const {addTransaction, clearDepreciatedTxns} = require("../core/txPool");
const rpc = require("../rpc/rpc");
const TYPE = require("./message-types");
const {verifyBlock, chooseProposer} = require("../consensus/consensus");
const {
  parseJSON,
  numToBuffer,
  serializeState,
  deserializeState,
} = require("../utils/utils");
const jelscript = require("../core/runtime");
const Merkle = require("../core/merkle");
const {SyncQueue} = require("./queue");
const {resolve} = require("path");

const opened = []; // Addresses and sockets from connected nodes.
const connected = []; // Addresses from connected nodes.
let connectedNodes = 0;

let worker = fork(`${__dirname}/../miner/worker.js`); // Worker thread (for PoW mining).

console.log(worker.events);

let mined = false; // This will be used to inform the node that another node has already mined before it.

// Some chain info cache
const chainInfo = {
  transactionPool: [],
  preparePool: [],
  commitPool: [],
  latestBlock: generateGenesisBlock(),
  latestSyncBlock: null,
  syncQueue: new SyncQueue(this),
  syncing: false,
  checkedBlock: {},
  // difficulty: 1
};

const stateDB = new Level(__dirname + "/../../log/stateStore", {
  valueEncoding: "buffer",
});
const blockDB = new Level(__dirname + "/../../log/blockStore", {
  valueEncoding: "buffer",
});
const bhashDB = new Level(__dirname + "/../../log/bhashStore", {
  valueEncoding: "buffer",
});
const txhashDB = new Level(__dirname + "/../../log/txhashStore");
const codeDB = new Level(__dirname + "/../../log/codeStore");
const addressDB = new Level(__dirname + "/../../log/addressStore");

// Function to connect to a node.
async function connect(MY_ADDRESS, address, publicKey) {
  if (
    !connected.find((peerAddress) => peerAddress === address) &&
    address !== MY_ADDRESS
  ) {
    // Get address's socket.
    const socket = new WS(address);

    // Open a connection to the socket.
    socket.on("open", async () => {
      for (const _address of [MY_ADDRESS, ...connected])
        socket.send(
          produceMessage(TYPE.HANDSHAKE, {
            address: _address,
            publicAddress: publicKey,
          })
        );
      for (const node of opened)
        node.socket.send(produceMessage(TYPE.HANDSHAKE, address));

      // If the address already existed in "connected" or "opened", we will not push, preventing duplications.
      if (
        !opened.find((peer) => peer.address === address) &&
        address !== MY_ADDRESS
      ) {
        opened.push({socket, address});
      }

      if (
        !connected.find((peerAddress) => peerAddress === address) &&
        address !== MY_ADDRESS
      ) {
        connected.push(address);

        connectedNodes++;

        console.log(
          `\x1b[32mLOG\x1b[0m [${new Date().toISOString()}] Connected to ${address}.`
        );

        // Listen for disconnection, will remove them from "opened" and "connected".
        socket.on("close", () => {
          opened.splice(connected.indexOf(address), 1);
          connected.splice(connected.indexOf(address), 1);

          console.log(
            `\x1b[32mLOG\x1b[0m [${new Date().toISOString()}] Disconnected from ${address}.`
          );
        });
      }
    });
    socket.on("error", async (error) => {
      console.log(
        `\x1b[31mERROR\x1b[0m [${new Date().toISOString()}] An error occurred with the socket: ${
          error.message
        }`
      );
    });
  }

  return true;
}

// Function to broadcast a transaction.
async function sendTransaction(transaction) {
  sendMessage(produceMessage(TYPE.CREATE_TRANSACTION, transaction), opened);
  // console.log(transaction);

  console.log(
    `\x1b[32mLOG\x1b[0m [${new Date().toISOString()}] Sent one transaction.`
  );

  await addTransaction(transaction, chainInfo, stateDB);
}

async function proposeBlock(publicKey, ENABLE_LOGGING) {
  function mine(block) {
    return new Promise((resolve, reject) => {
      worker.addListener("message", (message) => resolve(message.result));

      worker.send({type: "MINE", data: [block]}); // Send a message to the worker thread, asking it to mine.
    });
  }

  // Block(blockNumber = 1, timestamp = Date.now(), transactions = [], parentHash = "",coinbase = "")
  // Create a new block.
  const block = new Block(
    chainInfo.latestBlock.blockNumber + 1,
    Date.now(),
    [], // Will add transactions down here
    // chainInfo.difficulty,
    chainInfo.latestBlock.hash,
    SHA256(publicKey)
  );

  // Collect a list of transactions to mine
  const transactionsToMine = [];
  const states = {};
  const code = {};
  const storage = {};
  const skipped = {};
  let totalTxGas = 0n;
  let totalContractGas = 0n;

  const existedAddresses = await stateDB.keys().all();

  for (const tx of chainInfo.transactionPool) {
    if (
      totalContractGas + BigInt(tx.additionalData.contractGas || 0) >=
      BigInt(BLOCK_GAS_LIMIT)
    )
      break;

    const txSenderPubkey = Transaction.getPubKey(tx);
    const txSenderAddress = SHA256(txSenderPubkey);

    if (skipped[txSenderAddress]) continue; // Check if transaction is from an ignored address.

    const totalAmountToPay =
      BigInt(tx.amount) +
      BigInt(tx.gas) +
      BigInt(tx.additionalData.contractGas || 0);

    // Normal coin transfers
    if (!states[txSenderAddress]) {
      const senderState = deserializeState(await stateDB.get(txSenderAddress));

      states[txSenderAddress] = senderState;
      code[senderState.codeHash] = await codeDB.get(senderState.codeHash);

      if (
        senderState.codeHash !== EMPTY_HASH ||
        BigInt(senderState.balance) < totalAmountToPay
      ) {
        skipped[txSenderAddress] = true;
        continue;
      }

      states[txSenderAddress].balance = (
        BigInt(senderState.balance) -
        BigInt(tx.amount) -
        BigInt(tx.gas) -
        BigInt(tx.additionalData.contractGas || 0)
      ).toString();
    } else {
      if (
        states[txSenderAddress].codeHash !== EMPTY_HASH ||
        BigInt(states[txSenderAddress].balance) < totalAmountToPay
      ) {
        skipped[txSenderAddress] = true;
        continue;
      }

      states[txSenderAddress].balance = (
        BigInt(states[txSenderAddress].balance) -
        BigInt(tx.amount) -
        BigInt(tx.gas) -
        BigInt(tx.additionalData.contractGas || 0)
      ).toString();
    }

    if (!existedAddresses.includes(tx.recipient) && !states[tx.recipient]) {
      states[tx.recipient] = {
        balance: "0",
        codeHash: EMPTY_HASH,
        storageRoot: EMPTY_HASH,
      };
      code[EMPTY_HASH] = "";
    }

    if (existedAddresses.includes(tx.recipient) && !states[tx.recipient]) {
      states[tx.recipient] = deserializeState(await stateDB.get(tx.recipient));
      code[states[tx.recipient].codeHash] = await codeDB.get(
        states[tx.recipient].codeHash
      );
    }

    states[tx.recipient].balance = (
      BigInt(states[tx.recipient].balance) + BigInt(tx.amount)
    ).toString();

    // Contract deployment
    if (
      states[txSenderAddress].codeHash === EMPTY_HASH &&
      typeof tx.additionalData.scBody === "string"
    ) {
      states[txSenderAddress].codeHash = SHA256(tx.additionalData.scBody);
      code[states[txSenderAddress].codeHash] = tx.additionalData.scBody;
    }

    // Update nonce
    // states[txSenderAddress].nonce += 1;

    // Decide to drop or add transaction to block
    if (BigInt(states[txSenderAddress].balance) < 0n) {
      skipped[txSenderAddress] = true;
      continue;
    } else {
      transactionsToMine.push(tx);

      totalContractGas += BigInt(tx.additionalData.contractGas || 0);
      totalTxGas += BigInt(tx.gas) + BigInt(tx.additionalData.contractGas || 0);
    }

    // Contract execution
    if (states[tx.recipient].codeHash !== EMPTY_HASH) {
      const contractInfo = {address: tx.recipient};

      const [newState, newStorage] = await jelscript(
        code[states[tx.recipient].codeHash],
        states,
        BigInt(tx.additionalData.contractGas || 0),
        stateDB,
        block,
        tx,
        contractInfo,
        false
      );

      for (const account of Object.keys(newState)) {
        states[account] = newState[account];

        storage[tx.recipient] = newStorage;
      }
    }
  }

  const transactionsAsObj = [...transactionsToMine];

  block.transactions = transactionsToMine.map((tx) =>
    Transaction.serialize(tx)
  ); // Add transactions to block
  block.hash = Block.getHash(block); // Re-hash with new transactions
  block.txRoot = Merkle.buildTxTrie(transactionsAsObj).root; // Re-gen transaction root with new transactions

  // Mine the block.
  mine(block)
    .then(async (block) => {
      // If the block is not mined before, we will add it to our chain and broadcast this new block.
      if (!mined) {
        // await updateDifficulty(block, chainInfo, blockDB); // Update difficulty
        // console.log(block)

        await blockDB.put(
          block.blockNumber.toString(),
          Buffer.from(Block.serialize(block))
        ); // Add block to chain
        await bhashDB.put(block.hash, numToBuffer(block.blockNumber)); // Assign block number to the matching block hash

        // Assign transaction index and block number to transaction hash
        for (let txIndex = 0; txIndex < block.transactions.length; txIndex++) {
          const tx = Transaction.deserialize(block.transactions[txIndex]);
          const txHash = Transaction.getHash(tx);

          await txhashDB.put(
            txHash,
            block.blockNumber.toString() + " " + txIndex.toString()
          );
        }

        chainInfo.latestBlock = block; // Update latest block cache
        // console.log(chainInfo)
        // return;
        // Reward
        if (
          !existedAddresses.includes(block.coinbase) &&
          !states[block.coinbase]
        ) {
          states[block.coinbase] = {
            balance: "0",
            codeHash: EMPTY_HASH,
            storageRoot: EMPTY_HASH,
          };
          code[EMPTY_HASH] = "";
        }

        if (
          existedAddresses.includes(block.coinbase) &&
          !states[block.coinbase]
        ) {
          states[block.coinbase] = deserializeState(
            await stateDB.get(block.coinbase)
          );
          code[states[block.coinbase].codeHash] = await codeDB.get(
            states[block.coinbase].codeHash
          );
        }

        let gas = 0n;

        for (const tx of transactionsAsObj) {
          gas += BigInt(tx.gas) + BigInt(tx.additionalData.contractGas || 0);
        }

        states[block.coinbase].balance = (
          BigInt(states[block.coinbase].balance) +
          BigInt(BLOCK_REWARD) +
          gas
        ).toString();

        // Transit state
        for (const address in storage) {
          const storageDB = new Level(
            __dirname + "/../../log/accountStore/" + address
          );
          const keys = Object.keys(storage[address]);

          states[address].storageRoot = Merkle.buildTxTrie(
            keys.map((key) => key + " " + storage[address][key]),
            false
          ).root;

          for (const key of keys) {
            await storageDB.put(key, storage[address][key]);
          }

          await storageDB.close();
        }

        for (const account of Object.keys(states)) {
          await stateDB.put(
            account,
            Buffer.from(serializeState(states[account]))
          );

          await codeDB.put(
            states[account].codeHash,
            code[states[account].codeHash]
          );
        }

        // Update the new transaction pool (remove all the transactions that are no longer valid).
        chainInfo.transactionPool = await clearDepreciatedTxns(
          chainInfo,
          stateDB
        );

        sendMessage(
          produceMessage(
            TYPE.NEW_BLOCK,
            Block.serialize(chainInfo.latestBlock)
          ),
          opened
        ); // Broadcast the new block
        console.log(`Broadcast the new block`);
        console.log(chainInfo);
        console.log(
          `\x1b[32mLOG\x1b[0m [${new Date().toISOString()}] Block #${
            chainInfo.latestBlock.blockNumber
          } mined and synced, state transited.`
        );
      } else {
        mined = false;
      }

      // Re-create the worker thread
      worker.kill();

      worker = fork(`${__dirname}/../miner/worker.js`);
    })
    .catch((err) =>
      console.log(
        `\x1b[31mERROR\x1b[0m [${new Date().toISOString()}] Error at mining child process`,
        err
      )
    );
}

// Function to mine continuously
async function loopPropose(
  publicKey,
  MY_ADDRESS,
  currentSyncBlock,
  ENABLE_CHAIN_REQUEST,
  ENABLE_LOGGING,
  PROPOSE_INTERVAL,
  time = PROPOSE_INTERVAL
) {
  let length = chainInfo.latestBlock.blockNumber;
  let mining = true;

  setInterval(async () => {
    console.log(`length: ` + length);
    console.log(`mining: ` + mining);
    console.log(
      "latestBlock.blockNumber: " + chainInfo.latestBlock.blockNumber
    );
    console.log(`loop propose call`);

    // Random choose a proposer
    const proposerAddress = await addressDB.values().all();
    const validator = await chooseProposer(
      proposerAddress,
      chainInfo.latestBlock
    );
    console.log(`Proposer address: ` + validator);
    if (
      // mining ||
      // length !== chainInfo.latestBlock.blockNumber ||
      validator == SHA256(publicKey)
    ) {
      // mining = false;
      // length = chainInfo.latestBlock.blockNumber;

      await proposeBlock(publicKey, ENABLE_LOGGING);
      // if (!ENABLE_CHAIN_REQUEST) {
      //   await proposeBlock(publicKey, ENABLE_LOGGING);
      // }

      // } else {
      //   ENABLE_CHAIN_REQUEST = true;
      //   await enableChainRequest(
      //     currentSyncBlock,
      //     blockDB,
      //     stateDB,
      //     MY_ADDRESS
      //   ).then((newCurrentSyncBlock) => {
      //     currentSyncBlock = newCurrentSyncBlock;
      //   });

      console.log("ChainInfo in Loop mine");
      console.log(chainInfo);
    }
  }, time);
}

async function disableChainRequest(chainInfo) {
  console.log(`!ENABLE_CHAIN_REQUEST`);
  if ((await blockDB.keys().all()).length === 0) {
    // Initial state
    console.log(chainInfo.latestBlock);
    await stateDB.put(
      FIRST_ACCOUNT,
      Buffer.from(
        serializeState({
          balance: INITIAL_SUPPLY,
          codeHash: EMPTY_HASH,
          storageRoot: EMPTY_HASH,
        })
      )
    );

    await blockDB.put(
      chainInfo.latestBlock.blockNumber.toString(),
      Buffer.from(Block.serialize(chainInfo.latestBlock))
    );
    await bhashDB.put(
      chainInfo.latestBlock.hash,
      numToBuffer(chainInfo.latestBlock.blockNumber)
    ); // Assign block number to the matching block hash

    console.log(
      `\x1b[32mLOG\x1b[0m [${new Date().toISOString()}] Created Genesis Block with:\n` +
        `    Block number: ${chainInfo.latestBlock.blockNumber.toString()}\n` +
        `    Timestamp: ${chainInfo.latestBlock.timestamp.toString()}\n` +
        `    Coinbase: ${chainInfo.latestBlock.coinbase.toString()}\n` +
        `    Hash: ${chainInfo.latestBlock.hash.toString()}\n` +
        `    TxRoot: ${chainInfo.latestBlock.txRoot.toString()}`
    );

    await changeState(chainInfo.latestBlock, stateDB, codeDB);
  } else {
    // Update latest block in chain cache
    chainInfo.latestBlock = Block.deserialize([
      ...(await blockDB.get(
        Math.max(
          ...(await blockDB.keys().all()).map((key) => parseInt(key))
        ).toString()
      )),
    ]);
  }
}

async function enableChainRequest(currentSyncBlock, MY_ADDRESS) {
  const blockNumbers = await blockDB.keys().all();
  // const blockNumbers = chainInfo.latestBlock.blockNumber;

  // Get the last block in stateDB to synchronize
  if (blockNumbers.length !== 0) {
    currentSyncBlock = Math.max(...blockNumbers.map((key) => parseInt(key)));
    // currentSyncBlock = 1;
  }
  console.log(`ENABLE_CHAIN_REQUEST`);
  if (currentSyncBlock === 1) {
    // Lưu trạng thái khởi tạo vào tài khoản FIRST_ACCOUNT trong database stateDB
    await stateDB.put(
      FIRST_ACCOUNT,
      Buffer.from(
        serializeState({
          balance: INITIAL_SUPPLY,
          codeHash: EMPTY_HASH,
          storageRoot: EMPTY_HASH,
        })
      )
    );

    // Lưu thông tin Block hiện tại vào bản ghi có key số thứ tự của block (BlockNumber) trong database blockDB
    // await blockDB.put(chainInfo.latestBlock.blockNumber.toString(), Buffer.from(Block.serialize(chainInfo.latestBlock)));

    // Lưu BlockNumber của block  vào hash của block cuối cùng của chain trong database bhashDB
    // await bhashDB.put(chainInfo.latestBlock.hash, numToBuffer(chainInfo.latestBlock.blockNumber)); // Assign block number to the matching block hash

    // Update trạng thái của chainInfo, database thay đổi là stateDB và codeDB
    // await changeState(chainInfo.latestBlock, stateDB, codeDB);
  }

  // if ((await blockDB.keys().all()).length !== 0) {
  //   chainInfo.latestBlock = Block.deserialize([...(await blockDB.get(Math.max(...(await blockDB.keys().all()).map((key) => parseInt(key))).toString())),]);
  // }
  // if (pbft) {
  //   ENABLE_MINING = true;
  // } else {
  //   ENABLE_MINING;
  // }

  // if (ENABLE_MINING) {
  return new Promise((resolve) => {
    setTimeout(async () => {
      for (const node of opened) {
        node.socket.send(
          produceMessage(TYPE.REQUEST_BLOCK, {
            blockNumber: currentSyncBlock,
            requestAddress: MY_ADDRESS,
          })
        );
      }
      // Resolve the Promise with currentSyncBlock
      resolve(currentSyncBlock);
    }, 1000);
  });
  // }
}

async function startServer(options) {
  const PORT = options.PORT || 3000; // Node's PORT
  const RPC_PORT = options.RPC_PORT || 5000; // RPC server's PORT
  const PEERS = options.PEERS || []; // Peers to connect to
  const MAX_PEERS = options.MAX_PEERS || 10; // Maximum number of peers to connect to
  const MY_ADDRESS = options.MY_ADDRESS || "ws://localhost:3000"; // Node's address
  const ENABLE_MINING = options.ENABLE_MINING ? true : false; // Enable mining?
  const ENABLE_LOGGING = options.ENABLE_LOGGING ? true : false; // Enable logging?
  const ENABLE_RPC = options.ENABLE_RPC ? true : false; // Enable RPC server?
  let ENABLE_CHAIN_REQUEST = options.ENABLE_CHAIN_REQUEST ? true : false; // Enable chain sync request?
  const GENESIS_HASH = options.GENESIS_HASH || ""; // Genesis block's hash
  const PROPOSE_INTERVAL = options.PROPOSE_INTERVAL || 5000;

  const privateKey = options.PRIVATE_KEY || ec.genKeyPair().getPrivate("hex");
  const keyPair = ec.keyFromPrivate(privateKey, "hex");
  const publicKey = keyPair.getPublic("hex");

  process.on("uncaughtException", (err) =>
    console.log(
      `\x1b[31mERROR\x1b[0m [${new Date().toISOString()}] Uncaught Exception`,
      err
    )
  );

  await codeDB.put(EMPTY_HASH, "");
  // Lưu địa chỉ node
  await addressDB.put(MY_ADDRESS, SHA256(publicKey));

  const server = new WS.Server({port: PORT});

  console.log(
    `\x1b[32mLOG\x1b[0m [${new Date().toISOString()}] P2P server listening on PORT`,
    PORT.toString()
  );

  server.on("connection", async (socket, req) => {
    // Message handler
    socket.on("message", async (message) => {
      const _message = parseJSON(message); // Parse binary message to JSON

      switch (_message.type) {
        // Below are handlers for every message types.

        case TYPE.HANDSHAKE:
          const {address, publicAddress} = _message.data;
          console.log(`Handshake call`);

          if (connectedNodes <= MAX_PEERS) {
            try {
              await addressDB.put(address, SHA256(publicAddress));
              connect(MY_ADDRESS, address, publicKey);
            } catch (e) {
              // Debug console.log(e);
            }
          }
        case TYPE.REQUEST_BLOCK:
          const {blockNumber, requestAddress} = _message.data;
          let requestedBlock;
          console.log(`Request block call`);
          console.log(`Block number ${blockNumber}`);

          try {
            requestedBlock = [...(await blockDB.get(blockNumber.toString()))]; // Get block
          } catch (err) {
            if (err.notFound) {
              console.error(
                `Block number not found in blockDB: ${blockNumber}`
              );
            }
            // If block does not exist, break
            break;
          }

          const socket = opened.find(
            (node) => node.address === requestAddress
          ).socket; // Get socket from address
          socket.send(produceMessage(TYPE.SEND_BLOCK, requestedBlock)); // Send block
          console.log(
            `\x1b[32mLOG\x1b[0m [${new Date().toISOString()}] Sent block at position ${blockNumber} to ${requestAddress}.`
          );

          break;

        case TYPE.SEND_BLOCK:
          let block;
          console.log(`Send block call`);
          try {
            block = Block.deserialize(_message.data);
          } catch (error) {
            console.error(`block fails to be deserialized`);
            // If block fails to be deserialized, it's faulty
            return;
          }

          // If latest synced block is null, we immediately add the block into the chain without verification.
          // This happens due to the fact that the genesis block can discard every possible set rule ¯\_(ツ)_/¯

          // But wait, isn't that unsafe? Well, this is because we don't have an official JeChain "network" yet.
          // But if there is, one can generate the first genesis block and we can add its hash into config,
          // we then check if the genesis block matches with the hash which is safe.
          if (ENABLE_CHAIN_REQUEST && block.blockNumber === currentSyncBlock) {
            const verificationHandler = async function (block) {
              console.log("Verification call");

              if (
                (chainInfo.latestSyncBlock === null &&
                  (!GENESIS_HASH || GENESIS_HASH === block.hash)) || // For genesis
                (await verifyBlock(
                  block,
                  chainInfo,
                  stateDB,
                  codeDB,
                  ENABLE_LOGGING
                )) // For all others
              ) {
                await blockDB.put(
                  block.blockNumber.toString(),
                  Buffer.from(_message.data)
                ); // Add block to chain
                await bhashDB.put(block.hash, numToBuffer(block.blockNumber)); // Assign block number to the matching block hash
                console.log(chainInfo);

                // Assign transaction index and block number to transaction hash
                for (
                  let txIndex = 0;
                  txIndex < block.transactions.length;
                  txIndex++
                ) {
                  const tx = Transaction.deserialize(
                    block.transactions[txIndex]
                  );
                  const txHash = Transaction.getHash(tx);

                  await txhashDB.put(
                    txHash,
                    block.blockNumber.toString() + " " + txIndex.toString()
                  );
                }

                if (!chainInfo.latestSyncBlock) {
                  chainInfo.latestSyncBlock = block; // Update latest synced block.
                  await changeState(block, stateDB, codeDB, ENABLE_LOGGING); // Force transit state
                }

                chainInfo.latestBlock = block; // Update latest block cache
                console.log(
                  `\x1b[32mLOG\x1b[0m [${new Date().toISOString()}] Synced block at position ${
                    block.blockNumber
                  }.`
                );
                // await updateDifficulty(block, chainInfo, blockDB); // Update difficulty
                chainInfo.syncing = false;
                chainInfo.syncQueue.wipe(); // Wipe sync queue
                currentSyncBlock++;

                // Continue requesting the next block
                for (const node of opened) {
                  node.socket.send(
                    produceMessage(TYPE.REQUEST_BLOCK, {
                      blockNumber: currentSyncBlock,
                      requestAddress: MY_ADDRESS,
                    })
                  );
                }

                return true;
              }
              // else {
              //   if (!chainInfo.latestSyncBlock) {
              //     chainInfo.latestSyncBlock = block; // Update latest synced block.
              //     await changeState(block, stateDB, codeDB, ENABLE_LOGGING); // Force transit state
              //   }

              //   chainInfo.latestBlock = block; // Update latest block cache
              //   console.log(`\x1b[32mLOG\x1b[0m [${(new Date()).toISOString()}] Synced block at position ${block.blockNumber}.`);
              //   // await updateDifficulty(block, chainInfo, blockDB); // Update difficulty
              //   console.log(`Syncing: ${chainInfo.syncing}`)
              //   chainInfo.syncing = false;
              //   chainInfo.syncQueue.wipe(); // Wipe sync queue
              //   currentSyncBlock++;

              //   // Continue requesting the next block
              //   for (const node of opened) {
              //     node.socket.send(produceMessage(TYPE.REQUEST_BLOCK, { blockNumber: currentSyncBlock,requestAddress: MY_ADDRESS,}));
              //   }
              // }

              return false;
            };

            chainInfo.syncQueue.add(block, verificationHandler);
          }

          break;

        case TYPE.CREATE_TRANSACTION:
          if (ENABLE_CHAIN_REQUEST) break; // Unsynced nodes should not be able to proceed.

          // TYPE.CREATE_TRANSACTION is sent when someone wants to submit a transaction.
          // Its message body must contain a transaction.

          // Weakly verify the transation, full verification is achieved in block production.

          let transaction;
          console.log(`Create transaction call`);

          try {
            transaction = Transaction.deserialize(_message.data);
          } catch (e) {
            // If transaction can not be deserialized, it's faulty
            break;
          }

          if (!(await Transaction.isValid(transaction, stateDB))) break;

          // Get public key and address from sender
          const txSenderPubkey = Transaction.getPubKey(transaction);
          const txSenderAddress = SHA256(txSenderPubkey);

          if (!(await stateDB.keys().all()).includes(txSenderAddress)) break;

          // After transaction is added, the transaction must be broadcasted to others since the sender might only send it to a few nodes.

          // This is pretty much the same as addTransaction, but we will send the transaction to other connected nodes if it's valid.

          // Check nonce
          // let maxNonce = deserializeState(await stateDB.get(txSenderAddress)).nonce;

          // for (const tx of chainInfo.transactionPool) {
          //     const poolTxSenderPubkey = Transaction.getPubKey(transaction);
          //     const poolTxSenderAddress = SHA256(poolTxSenderPubkey);

          //     if (poolTxSenderAddress === txSenderAddress && tx.nonce > maxNonce) {
          //         maxNonce = tx.nonce;
          //     }
          // }

          // if (maxNonce + 1 !== transaction.nonce) return;

          console.log(
            `\x1b[32mLOG\x1b[0m [${new Date().toISOString()}] New transaction received, broadcasted and added to pool.`
          );

          chainInfo.transactionPool.push(transaction);

          // Broadcast the transaction
          sendMessage(message, opened);

          break;

        case TYPE.NEW_BLOCK:
          // "TYPE.NEW_BLOCK" is sent when someone wants to submit a new block.
          // Its message body must contain the new block and the new difficulty.

          let newBlock;
          console.log("New Block call");

          try {
            newBlock = Block.deserialize(_message.data);
          } catch (e) {
            // If block fails to be deserialized, it's faulty
            if (e.notFound) {
              console.error(`Block number not found in blockDB: ${newBlock}`);
            }
            return;
          }
          // We will only continue checking the block if its parentHash is not the same as the latest block's hash.
          // This is because the block sent to us is likely duplicated or from a node that has lost and should be discarded.

          if (!chainInfo.checkedBlock[newBlock.hash]) {
            chainInfo.checkedBlock[newBlock.hash] = true;
          } else {
            return;
          }

          if (
            newBlock.parentHash !== chainInfo.latestBlock.parentHash &&
            (!ENABLE_CHAIN_REQUEST ||
              (ENABLE_CHAIN_REQUEST && currentSyncBlock > 1))
            // Only proceed if syncing is disabled or enabled but already synced at least the genesis block
          ) {
            chainInfo.checkedBlock[newBlock.hash] = true;
            // Need to check again
            if (
              await verifyBlock(
                newBlock,
                chainInfo,
                stateDB,
                codeDB,
                ENABLE_LOGGING
              )
            ) {
              console.log(
                `\x1b[32mLOG\x1b[0m [${new Date().toISOString()}] New block received.`
              );

              // If mining is enabled, we will set mined to true, informing that another node has mined before us.
              if (ENABLE_MINING) {
                mined = true;

                worker.kill(); // Stop the worker thread

                worker = fork(`${__dirname}/../miner/worker.js`); // Renew
              }

              // await updateDifficulty(newBlock, chainInfo, blockDB); // Update difficulty

              // console.log(`NEW_BLOCK call ${newBlock.blockNumber}`)
              await blockDB.put(
                newBlock.blockNumber.toString(),
                Buffer.from(_message.data)
              ); // Add block to chain
              await bhashDB.put(
                newBlock.hash,
                numToBuffer(newBlock.blockNumber)
              ); // Assign block number to the matching block hash

              // Apply to all txns of the block: Assign transaction index and block number to transaction hash
              for (
                let txIndex = 0;
                txIndex < newBlock.transactions.length;
                txIndex++
              ) {
                const tx = Transaction.deserialize(
                  newBlock.transactions[txIndex]
                );
                const txHash = Transaction.getHash(tx);

                await txhashDB.put(
                  txHash,
                  newBlock.blockNumber.toString() + " " + txIndex.toString()
                );
              }

              chainInfo.latestBlock = newBlock; // Update latest block cache
              // chainInfo.latestSyncBlock = newBlock;

              // Update the new transaction pool (remove all the transactions that are no longer valid).
              chainInfo.transactionPool = await clearDepreciatedTxns(
                chainInfo,
                stateDB
              );

              console.log(
                `\x1b[32mLOG\x1b[0m [${new Date().toISOString()}] Block #${
                  newBlock.blockNumber
                } synced, state transited.`
              );

              // sendMessage(message, opened); // Broadcast block to other nodes
              if (ENABLE_CHAIN_REQUEST) {
                ENABLE_CHAIN_REQUEST = false;
              }
            }
          }

          break;

        case TYPE.PREPARE:
          break;
        case TYPE.COMMIT:
          break;
      }
    });
  });

  try {
    PEERS.forEach(async (peer) => await connect(MY_ADDRESS, peer, publicKey)); // Connect to peers
  } catch (e) {}

  // If node is a proposer
  if (!ENABLE_CHAIN_REQUEST) {
    await disableChainRequest(chainInfo);
  }
  // Sync chain
  let currentSyncBlock = 1;

  if (ENABLE_CHAIN_REQUEST) {
    await enableChainRequest(currentSyncBlock, MY_ADDRESS).then(
      (newCurrentSyncBlock) => {
        currentSyncBlock = newCurrentSyncBlock;
      }
    );
  }
  // Transaction(recipient = "", amount = "0", gas = "1000000000000", additionalData = {}) {
  // const transactionNew = new Transaction("04042809485ba7ee059057d2f1eedb5a1f5f208e15f775c17ffd0bd744df0dd2a285b52859ac708ee7ee9d43f61c3eb2a498527121f2b22a5b4ce17b84ccdb6bd3", 30, 20, {contractGas: 2})
  // Transaction.sign(transactionNew, keyPair)
  // await sendTransaction(transactionNew)

  // const transaction1 = new Transaction("04324ae590b69c924fce7383f777c62868ce8a5deb23df58adb882f1c8d4e9cfa77e57a8a72832213bfbc6b641f42c492b638ae723e894db0463ddb3c8595f234b", 300, 200, {contractGas: 20})
  // Transaction.sign(transaction1, keyPair)
  // await sendTransaction(transaction1)

  // const myContract = ``;
  // const transaction = new Transaction("contract address", amount, gas, {
  //   scBody: myContract
  // });
  // Transaction.sign(transaction, keyPair);
  // sendTransaction(transaction);

  if (ENABLE_MINING)
    loopPropose(
      publicKey,
      MY_ADDRESS,
      currentSyncBlock,
      ENABLE_CHAIN_REQUEST,
      ENABLE_LOGGING,
      PROPOSE_INTERVAL
    );
  if (ENABLE_RPC)
    rpc(
      RPC_PORT,
      {publicKey, mining: ENABLE_MINING, chainInfo},
      sendTransaction,
      keyPair,
      stateDB,
      blockDB,
      bhashDB,
      codeDB,
      txhashDB
    );
}

module.exports = {startServer};
