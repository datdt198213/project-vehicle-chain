const { Level } = require("level");
const Block = require("../core/block");

const {
  parseJSON,
  numToBuffer,
  serializeState,
  deserializeState,
} = require("../utils/utils");
const stateDB = new Level("../../log/stateStore", {
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

const getStateDB = async (account) => {
    return new Promise((resolve, reject) => {
      stateDB.get(account, (err, value) => {
        if (err) {
          console.error("Error retrieving state data:", err);
          reject(err); // Reject the promise if there's an error
        } else {
          const deserializedValue = deserializeState(value);
          const balance = deserializedValue.balance;
          const codeHash = deserializedValue.codeHash;
          const storageRoot = deserializedValue.storageRoot;
          const state = {
            balance: balance,
            codeHash: codeHash,
            storageRoot: storageRoot,
          };
          resolve(state); // Resolve the promise with the retrieved state
        }
      });
    });
};

const getBlockDB = async (blockNumber) => {
    return new Promise((resolve, reject) => {
        blockDB.get(blockNumber.toString(), (err, value) => {
            if (err) {
                console.error(`Can not get block by block number ${blockNumber}: ${err}`);
                reject(err);
            } else {
                const deserializedValue = Block.deserialize(value);
                const blockNumber = deserializedValue.blockNumber;
                const timestamp = deserializedValue.timestamp;
                const parentHash = deserializedValue.parentHash;
                const txRoot = deserializedValue.txRoot;
                const coinbase = deserializedValue.coinbase;
                const hash = deserializedValue.hash;
                const block = {
                    blockNumber: blockNumber,
                    timestamp: timestamp,
                    parentHash: parentHash,
                    txRoot: txRoot,
                    coinbase: coinbase,
                    hash: hash,
                  };
                resolve(block)
            }
        })
    })
}

const getbhashDB = async (blockHash) => {
    return new Promise((resolve, reject) => {
        bhashDB.get(blockHash, (err, value) => {
            if(err) {
                console.error(`Can not retrieve block hash ${blockHash}: ${err}`)
                reject(err);
            } else {
                const blockNumber = value.readUIntBE(0, value.length);
                resolve(blockNumber)
            }
        })
    })
}

const getTxHash = async (txHash) => {
    return new Promise((resolve, reject) => {
        txhashDB.get(txHash, (err, value) => {
            if (err) {
                console.error(`Can not get transaction hash ${txHash}: ${err}`)
                reject(err);
            } else {
                const deserializedValue = deserializeState(value);
                resolve(deserializedValue)
            }
        })
    })
}

const getCodeDB = async (code) => {
    return new Promise((resolve, reject) => {
        codeDB.get(code, (err, value) => {
            if(err) {
                console.error(`Can not get code ${code}: ${err} `);
                reject(err);
            } else {
                console.log(`Value ${value}`)
                const deserializedValue = deserializeState(value);
                console.log(deserializedValue)
                resolve(deserializedValue);
            }
        })
    })
}



// *** TEST ***
const main = async () => {
    /*
    const account = "52472d59e3c01bc2cf9496c959d924ce5f469d4e097c395f5605f70633e44a28"
    const sDB = await getStateDB(account);
    console.log(sDB)
    */

    
    // const blockNumber = 3;
    // for (let i = 1 ; i < blockNumber; i++) {
    //     const bDB = await getBlockDB(i);
    //     console.log(bDB)
    // }
 
    
    // const blockHash = 'df58ad88a16af7f7d98a0e6bb7247b30a1e35f585fba0c8cd9e401f5692e10c5'
    // const bhash = await getbhashDB(blockHash);
    // console.log(bhash)

    // const code = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    // const codeDatabase = await getCodeDB(code);
    // console.log(code)
}

main();
