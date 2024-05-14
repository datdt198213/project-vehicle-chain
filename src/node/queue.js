"use strict";

class SyncQueue {
    constructor (chainInfo) {
        this.queue = [];
        this.chainInfo = chainInfo;
    }

    async add(block, verificationHandler) {
        this.queue.push(block);

        if (!this.chainInfo.syncing) {
            this.chainInfo.syncing = true;
            // console.log(`Sync in add function: ${this.chainInfo.syncing}`);
            
            await this.sync(verificationHandler);
        }

    }

    async sync(verificationHandler) {
        while (this.queue.length !== 0) {
            const block = this.queue.shift(); // Trả về phần tử đầu tiên của mảng và bỏ phần tử đấy đi
            // console.log(`Sync in sync function: ${this.chainInfo.syncing}`);
            
            if (await verificationHandler(block)) break;
        }

        this.chainInfo.syncing = false;
    }

    wipe() {
        this.queue = [];
    }
}

module.exports = { SyncQueue };
