"use strict";

const crypto = require("crypto"),
  SHA256 = (message) =>
    crypto.createHash("sha256").update(message).digest("hex");
const EC = require("elliptic").ec,
  ec = new EC("secp256k1");

const jelscript = require("./runtime");

const { BLOCK_GAS_LIMIT } = require("../config.json");
const { deserializeState, serializeState } = require("../utils/utils");
const Block = require("./block");

async function addBlock(block, chainInfo, bhashDB){
    try{
        block = Block.deserialize(block);
    } catch (e) {
        console.log(`\x1b[31mERROR\x1b[0m [${(new Date()).toISOString()}] Failed to add block to pool: Can not deserialize block.`);
    
        // If block can not be deserialized, it's faulty
        return;
    }

    if(await verifyBlock(newBlock, chainInfo, stateDB, codeDB, ENABLE_LOGGING)) {
        console.log(`\x1b[31mERROR\x1b[0m [${new Date().toISOString()}] Failed to add block to pool: Block is invalid.`);
    
        return;
    }

    const blockPool = chainInfo.blockPool
    blockPool.push(block)
}