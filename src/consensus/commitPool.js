

class CommitPool {
    // Danh sách của chứa thông điệp commit cho hash của block
    constructor() {
      this.list = {};
    }
  
    // Commit khởi tạo một list các thông điệp commit cho từng thông điệp prepare
    // and adds the commit message for the current node and
    // returns it
    commit(prepare, transaction) {
      let commit = this.createCommit(prepare, transaction);
      this.list[prepare.blockHash] = [];
      this.list[prepare.blockHash].push(commit);
      return commit;
    }
  
    // creates a commit message for the given prepare message
    createCommit(prepare, transaction) {
      let commit = {};
      commit.blockHash = prepare.blockHash;
      commit.publicKey = wallet.getPublicKey(tx);
      commit.signature = wallet.sign(prepare.blockHash);
      return commit;
    }
  
    // checks if the commit message already exists
    existingCommit(commit) {
      let exists = this.list[commit.blockHash].find(
        p => p.publicKey === commit.publicKey
      );
      return exists;
    }
  
    // checks if the commit message is valid or not
    isValidCommit(commit) {
      return ChainUtil.verifySignature(
        commit.publicKey,
        commit.signature,
        commit.blockHash
      );
    }
  
    // pushes the commit message for a block hash into the list
    addCommit(commit) {
      this.list[commit.blockHash].push(commit);
    }
  }
  
  module.exports = CommitPool;