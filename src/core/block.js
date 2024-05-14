"use strict";

const { Level } = require("level");
const crypto = require("crypto"),
  SHA256 = (message) =>
    crypto.createHash("sha256").update(message).digest("hex");
const EC = require("elliptic").ec,
  ec = new EC("secp256k1");
const Transaction = require("./transaction");
const Merkle = require("./merkle");
const { BLOCK_REWARD, BLOCK_GAS_LIMIT, EMPTY_HASH } = require("../config.json");
const jelscript = require("./runtime");
const { serializeState, deserializeState } = require("../utils/utils");

class Block {
  constructor(blockNumber = 1, timestamp = Date.now(), transactions = [], parentHash = "", coinbase = "") {
    this.transactions = transactions; // Transaction list

    // Block header
    this.blockNumber = blockNumber; // Block's index in chain
    this.timestamp = timestamp; // Block creation timestamp
    this.parentHash = parentHash; // Parent (previous) block's hash
    this.coinbase = coinbase; // Address to receive reward
    this.hash = Block.getHash(this); // Hash of the block
    // Merkle root of transactions
    this.txRoot = Merkle.buildTxTrie(
      transactions.map((tx) => Transaction.deserialize(tx))
    ).root;
  }

  // Thiết lập dữ liệu của block ra dạng hex
  static serialize(inputBlock) {
    // Block fields

    // - Block number: 4 bytes | Int
    // - Timestamp: 6 bytes | Int
    // - Parent hash: 32 bytes | Hex string
    // - Tx root: 32 bytes | Hex string
    // - Coinbase: 32 bytes | Hex string
    // - Hash: 32 bytes | Hex string
    // - Transactions: What's left, for each transaction we do:
    //   - Offset: 4 bytes | Int
    //   - Transaction body: <offset> bytes | Byte array

    let blockHexStr = "";

    // Block number
    blockHexStr += inputBlock.blockNumber.toString(16).padStart(8, "0");
    // Timestamp
    blockHexStr += inputBlock.timestamp.toString(16).padStart(12, "0");
    // Parent hash
    blockHexStr += inputBlock.parentHash.toString(16).padStart(64, "0");
    // Tx root
    blockHexStr += inputBlock.txRoot.toString(16).padStart(64, "0");
    // Coinbase
    blockHexStr += inputBlock.coinbase.toString(16).padStart(64, "0");
    // Hash
    blockHexStr += inputBlock.hash.toString(16).padStart(64, "0");

    // Transactions
    for (const tx of inputBlock.transactions) {
      // Offset for knowing transaction's size
      blockHexStr += tx.length.toString(16).padStart(8, "0");

      // The transaction
      blockHexStr += Buffer.from(tx).toString("hex");
    }

    return new Array(...Buffer.from(blockHexStr, "hex"));
  }

  // Tái thiết lại đối tượng block từ hex
  static deserialize(block) {
    let blockHexStr = Buffer.from(block).toString("hex");

    const myBlock = { transactions: [] };

    // Block number
    myBlock.blockNumber = parseInt(blockHexStr.slice(0, 8), 16);
    blockHexStr = blockHexStr.slice(8);

    // Timestamp
    myBlock.timestamp = parseInt(blockHexStr.slice(0, 12), 16);
    blockHexStr = blockHexStr.slice(12);

    // Parent Hash
    myBlock.parentHash = blockHexStr.slice(0, 64), 16;
    blockHexStr = blockHexStr.slice(64);

    // Tx root
    myBlock.txRoot = blockHexStr.slice(0, 64);
    blockHexStr = blockHexStr.slice(64);

    // Coinbase
    myBlock.coinbase = blockHexStr.slice(0, 64);
    blockHexStr = blockHexStr.slice(64);

    // Hash
    myBlock.hash = blockHexStr.slice(0, 64);
    blockHexStr = blockHexStr.slice(64);

    // Transaction
    while (blockHexStr.length > 0) {
      // Offset
      let offset = parseInt(blockHexStr.slice(0, 8), 16);

      blockHexStr = blockHexStr.slice(8);

      // The transaction
      myBlock.transactions.push([
        ...Buffer.from(blockHexStr.slice(0, offset * 2), "hex"),
      ]);

      blockHexStr = blockHexStr.slice(offset * 2);
    }

    return myBlock;
  }

  // Băm dữ liệu block ra mã băm
  static getHash(block) {
    // Convert every piece of data to string, merge and then hash
    // return SHA256(
    //     block.blockNumber.toString()       +
    //     block.timestamp.toString()         +
    //     block.txRoot                       +
    //     block.difficulty.toString()        +
    //     block.parentHash                   +
    //     block.nonce.toString()
    // );
    return SHA256(
      block.blockNumber.toString() +
        block.timestamp.toString() +
        block.txRoot +
        block.parentHash
    );
  }

  static async verifyTransactionAndTransit(
    myBlock,
    stateDB,
    codeDB,
    enableLogging = false
  ) {
    // Basic verification
    for (const tx of myBlock.transactions) {
      if (!(await Transaction.isValid(tx, stateDB))) return false;
    }

    // Get all existing addresses
    const addressesInBlock = myBlock.transactions.map((tx) =>
      SHA256(Transaction.getPubKey(tx))
    );
    const existedAddresses = await stateDB.keys().all();

    // If senders' address doesn't exist, return false
    if (!addressesInBlock.every((address) => existedAddresses.includes(address)))
      return false;

    // Start state replay to check if transactions are legit
    let states = {},
      code = {},
      storage = {};

    for (const tx of myBlock.transactions) {
      const transactionSenderPublicKey = Transaction.getPubKey(tx);
      const transactionSenderAddress = SHA256(transactionSenderPublicKey);

      const totalAmountToPay =
        BigInt(tx.amount) +
        BigInt(tx.gas) +
        BigInt(tx.additionalData.contractGas || 0);

      if (!states[transactionSenderAddress]) {
        const senderState = deserializeState(await stateDB.get(transactionSenderAddress));

        states[transactionSenderAddress] = senderState;

        code[senderState.codeHash] = await codeDB.get(senderState.codeHash);

        if (
          senderState.codeHash !== EMPTY_HASH ||
          BigInt(senderState.balance) < totalAmountToPay
        )
          return false;

        states[transactionSenderAddress].balance = (
          BigInt(senderState.balance) - totalAmountToPay
        ).toString();
      } else {
        if (
          states[txSenderAddress].codeHash !== EMPTY_HASH ||
          BigInt(states[txSenderAddress].balance) < totalAmountToPay
        )
          return false;

        states[txSenderAddress].balance = (
          BigInt(states[txSenderAddress].balance) - totalAmountToPay
        ).toString();
      }

      // Contract deployment
      if (
        states[transactionSenderAddress].codeHash === EMPTY_HASH &&
        typeof tx.additionalData.scBody === "string"
      ) {
        states[transactionSenderAddress].codeHash = SHA256(
          tx.additionalData.scBody
        );
        code[states[transactionSenderAddress].codeHash] =
          tx.additionalData.scBody;
      }

      // Update nonce
      // states[transactionSenderAddress].nonce += 1;

      if (BigInt(states[transactionSenderAddress].balance) < 0n) return false;

      if (!existedAddresses.includes(tx.recipient) && !states[tx.recipient]) {
        // states[tx.recipient] = { balance: "0", codeHash: EMPTY_HASH, nonce: 0, storageRoot: EMPTY_HASH }
        states[tx.recipient] = {
          balance: "0",
          codeHash: EMPTY_HASH,
          storageRoot: EMPTY_HASH,
        };
        code[EMPTY_HASH] = "";
      }

      if (existedAddresses.includes(tx.recipient) && !states[tx.recipient]) {
        states[tx.recipient] = deserializeState(
          await stateDB.get(tx.recipient)
        );
        code[states[tx.recipient].codeHash] = await codeDB.get(
          states[tx.recipient].codeHash
        );
      }

      states[tx.recipient].balance = (
        BigInt(states[tx.recipient].balance) + BigInt(tx.amount)
      ).toString();

      // Contract execution
      if (states[tx.recipient].codeHash !== EMPTY_HASH) {
        const contractInfo = { address: tx.recipient };

        const [newState, newStorage] = await jelscript(
          code[states[tx.recipient].codeHash],
          states,
          BigInt(tx.additionalData.contractGas || 0),
          stateDB,
          myBlock,
          tx,
          contractInfo,
          enableLogging
        );

        for (const account of Object.keys(newState)) {
          states[account] = newState[account];
        }

        storage[tx.recipient] = newStorage;
      }
    }

    // Reward

    if (
      !existedAddresses.includes(myBlock.coinbase) &&
      !states[myBlock.coinbase]
    ) {
      // states[myBlock.coinbase] = { balance: "0", codeHash: EMPTY_HASH, nonce: 0, storageRoot: EMPTY_HASH }
      states[myBlock.coinbase] = {
        balance: "0",
        codeHash: EMPTY_HASH,
        storageRoot: EMPTY_HASH,
      };
      code[EMPTY_HASH] = "";
    }

    if (
      existedAddresses.includes(myBlock.coinbase) &&
      !states[myBlock.coinbase]
    ) {
      states[myBlock.coinbase] = deserializeState(
        await stateDB.get(myBlock.coinbase)
      );
      code[states[myBlock.coinbase].codeHash] = await codeDB.get(
        states[myBlock.coinbase].codeHash
      );
    }

    let gas = 0n;

    for (const tx of myBlock.transactions) {
      gas += BigInt(tx.gas) + BigInt(tx.additionalData.contractGas || 0);
    }

    states[myBlock.coinbase].balance = (
      BigInt(states[myBlock.coinbase].balance) +
      BigInt(BLOCK_REWARD) +
      gas
    ).toString();

    // Finalize state and contract storage into DB
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
        // Insert data to storageDB
        await storageDB.put(key, storage[address][key]);
      }

      await storageDB.close();
    }

    for (const account of Object.keys(states)) {
      await stateDB.put(account, Buffer.from(serializeState(states[account])));

      await codeDB.put(
        states[account].codeHash,
        code[states[account].codeHash]
      );
    }

    myBlock.transactions = myBlock.transactions.map((tx) => Transaction.serialize(tx));

    return true;
  }

  static async hasValidTxOrder(block, stateDB) {
    // Deserialize transactions - garbage code, will be deleted in the future
    try {
      block.transactions = block.transactions.map((tx) =>
        Transaction.deserialize(tx)
      );
    } catch (e) {
      // If a transaction fails to be deserialized, the block is faulty
      return false;
    }

    // const nonces = {};

    // for (const tx of block.transactions) {
    //     const txSenderPubkey = Transaction.getPubKey(tx);
    //     const txSenderAddress = SHA256(txSenderPubkey);

    //     if (typeof nonces[txSenderAddress] === "undefined") {
    //         const senderState = deserializeState(await stateDB.get(txSenderAddress));

    //         nonces[txSenderAddress] = senderState.nonce;
    //     }

    //     if (nonces[txSenderAddress] + 1 !== tx.nonce) return false;

    //     nonces[txSenderAddress]++;
    // }

    return true;
  }

  static hasValidGasLimit(block) {
    let totalGas = 0n;

    for (const tx of block.transactions) {
      totalGas += BigInt(tx.additionalData.contractGas || 0);
    }

    return totalGas <= BigInt(BLOCK_GAS_LIMIT);
  }
}

module.exports = Block;
