"use strict";

function log16(x) {
    return Math.log(x) / Math.log(16);
}

function isNumber(str) {
    return str.split("").every(char => "0123456789".includes(char));
}

function isHex(str) {
    return (
        str.startsWith("0x") &&
        str.slice(2).split("").every(char => "0123456789abcdef".includes(char))
    )
}

function bigIntable(str) {
    try {
        BigInt(str);

        return true;
    } catch (e) {
        return false;
    }
}

function parseJSON(value) {
    let parsed;
    
    try {
        parsed = JSON.parse(value);
    } catch (e) {
        return {};
    }

    return parsed;
}

function numToBuffer(value) {
    const hexValue = value.toString(16);
    const hexLength = hexValue.length + (hexValue.length % 2 !== 0 ? 1 : 0);

    return Buffer.from(hexValue.padStart(hexLength, "0"), "hex");
}

function serializeState(stateHeader) {
    let hexState = "";

    hexState += BigInt(stateHeader.balance).toString(16).padStart(22, "0"); // 00000005a23d031d262000

    hexState += stateHeader.codeHash; // 00000005a23d031d262000e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

    hexState += stateHeader.storageRoot; // 00000005a23d031d262000e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

    return new Array(...Buffer.from(hexState, "hex"));
}

function deserializeState(stateInBytes) {
    const stateHeader = {};
    let hexState = Buffer.from(stateInBytes).toString("hex"); //00000002d11e818e931000e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    
    stateHeader.balance = BigInt("0x" + hexState.slice(0, 22)).toString(); // 202977000000000000
    hexState = hexState.slice(22);
    

    stateHeader.codeHash = hexState.slice(0, 64); // e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    hexState = hexState.slice(64);

    stateHeader.storageRoot = hexState.slice(0, 64); // e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    hexState = hexState.slice(64);

    return stateHeader;
}

module.exports = { log16, isNumber, isHex, parseJSON, bigIntable, numToBuffer, serializeState, deserializeState };
