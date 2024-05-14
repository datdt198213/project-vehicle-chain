
class PBFT {
    constructor() {
        this.view = 0;
        this.phase = 'committed';
        this.prePrepare = {};
        this.prepare = {};
        this.commit = {};
        this.viewChange = {};
    }

    updateView(view) {
        this.view = view;
    }

    changeView() {
        this.view++;
    }

    switchPhase(phase) {
        this.phase = phase;
    }

    inPrePrepare(blockHash) {
        if (this.prePrepare[blockHash] == undefined) return false;
        return true;
    }

    addToPrePrepare(block) {
        this.prePrepare[block.hash] = block;
    }

    getBlock(blockHash) {
        if (this.prePrepare[blockHash] == undefined) return null;
        return this.prePrepare[blockHash];
    }

    createPrepare(blockHash, validatorWallet) {
        const prepare = {
            blockHash: blockHash,
            validatorAddress: validatorWallet.address,
            signature: validatorWallet.sign(blockHash)
        };
        this.prepare[blockHash] = [];
        this.prepare[blockHash].push(prepare);
        return prepare;
    }

    inPrepare(prepare) {
        if (this.prepare[prepare.blockHash] == undefined) return false;
        if (this.prepare[prepare.blockHash].find(p => p.validatorAddress == prepare.validatorAddress)) return true;
        return false;
    }

    verifyPrepare(prepare) {
        if (prepare.validatorAddress == Wallet.recover(prepare.blockHash, prepare.signature)) return true;
        return false;
    }

    addToPrepare(prepare) {
        if (this.prepare[prepare.blockHash] == undefined) this.prepare[prepare.blockHash] = [];
        this.prepare[prepare.blockHash].push(prepare);
    }

    createCommit(blockHash, validatorWallet) {
        const commit = {
            blockHash: blockHash,
            validatorAddress: validatorWallet.address,
            signature: validatorWallet.sign(blockHash)
        };
        this.commit[blockHash] = [];
        this.commit[blockHash].push(commit);
        return commit;
    }

    inCommit(commit) {
        if (this.commit[commit.blockHash] == undefined) return false;
        if (this.commit[commit.blockHash].find(c => c.validatorAddress == commit.validatorAddress)) return true;
        return false;
    }

    verifyCommit(commit) {
        if (commit.validatorAddress == Wallet.recover(commit.blockHash, commit.signature)) return true;
        return false;
    }

    addToCommit(commit) {
        if (this.commit[commit.blockHash] == undefined) this.commit[commit.blockHash] = [];
        this.commit[commit.blockHash].push(commit);
    }

    // createViewChange(blockHash, validatorWallet) {
    //     const viewChange = {
    //         blockHash: blockHash,
    //         view: this.view + 1,
    //         validatorAddress: validatorWallet.address,
    //         signature: validatorWallet.sign({ blockHash: blockHash, view: this.view + 1 })
    //     };
    //     this.viewChange[blockHash] = [];
    //     this.viewChange[blockHash].push(viewChange);
    //     return viewChange;
    // }

    // inViewChange(viewChange) {
    //     if (this.viewChange[viewChange.blockHash] == undefined) return false;
    //     if (this.viewChange[viewChange.blockHash].find(v => v.validatorAddress == viewChange.validatorAddress)) return true;
    //     return false;
    // }

    // verifyViewChange(viewChange) {
    //     if (
    //         viewChange.validatorAddress == Wallet.recover({ blockHash: viewChange.blockHash, view: viewChange.view }, viewChange.signature) &&
    //         viewChange.view == this.view + 1
    //     ) return true;
    //     return false;
    // }
}

module.exports = PBFT;