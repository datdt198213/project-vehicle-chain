const crypto = require("crypto"), SHA256 = message => crypto.createHash("sha256").update(message).digest("hex");
const EC = require("elliptic").ec, ec = new EC("secp256k1");
const Transaction = require("../core/transaction");
const Block = require("../core/block");

class PreparePool {
    // Danh sách của chứa thông điệp prepare cho hash của block
    constructor() {
        this.list = {};
    }

    // prepare khởi tạo một danh sách các thông điệp prepare của một block
    // gắn thông điệp commit cho từng node hiện tại và trả lại 
    prepare(block, transaction) {
        let prepare = this.createPrepare(block, transaction);
        this.list[block.hash] = [];
        this.list[block.hash].push(prepare);
        return prepare;
      }

    // tạo thông điệp prepare cho block
    createPrepare(block,transaction){
        let prepare = {
            blockHash: block.hash,
            publicKey: transaction.getPubKey(tx),
            signature: transaction.sign(tx,keyPair)
        };

        return prepare;
    }

    // đẩy thông điệp prepare cho một block hash vào list
    addPrepare(prepare) {
        this.list[prepare.blockHash].push(prepare);
    }

    // check nếu thông điệp prepare đã tồn tại
    existingPrepare(prepare) {
        let exists = this.list[prepare.blockHash].find(
            p => p.publicKey === prepare.publicKey
        );
        return exists;
    }

    // validate thông điệp prepare
    isValidPrepare(prepare) {
        return ec.keyFromPublic(prepare.publicKey)
            .verify(prepare.signature,prepare.blockHash);
    }
}

module.exports = PreparePool;