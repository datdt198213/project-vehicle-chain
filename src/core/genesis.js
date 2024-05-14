"use strict";

const EC = require("elliptic").ec, ec = new EC("secp256k1");
const crypto = require("crypto"), SHA256 = message => crypto.createHash("sha256").update(message).digest("hex");

const Block = require("./block");
const Transaction = require("./transaction");
const { FIRST_ACCOUNT } = require("../config.json");

function generateGenesisBlock() {
  // Block(blockNumber = 1, timestamp = Date.now(), transactions = [], parentHash = "",coinbase = "")
    return new Block(1, Date.now(), [], "0000000000000000000000000000000000000000000000000000000000000000", FIRST_ACCOUNT);
}

module.exports = generateGenesisBlock;
