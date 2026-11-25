"use strict";

const {isMainThread, parentPort, workerData} = require("worker_threads");
const parser = require("./tm2Psx.module.js");

if (!isMainThread) {
    void (async () => {
        try {
            let result;
            switch (workerData?.command) {
                case "ping": result = "ok"; break;
                case "scan": result = await parser.scan(workerData.sourceDir, workerData.options); break;
                case "parse":
                    result = await parser.parseFile(workerData.sourcePath, workerData.options);
                    break;
                case "write":
                    result = await parser.writeFile(workerData.sourcePath, workerData.destinationPath, workerData.options);
                    break;
                default: throw new Error("Unknown parser worker command: " + workerData?.command);
            }
            parentPort.postMessage({result, errors: []});
        } catch (error) {
            parentPort.postMessage({result: null, errors: [error.stack || String(error)]});
        }
    })();
}

