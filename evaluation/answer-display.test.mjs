import assert from "node:assert/strict";
import {readablePreview} from "../src/answerDisplay.ts";

assert.equal(readablePreview("Bootloader 在复位后检"),"","partial clause stays hidden");
assert.equal(readablePreview("Bootloader 在复位后检查镜像。后续"),"Bootloader 在复位后检查镜像。");
assert.equal(readablePreview("先校验镜像，再选择应用\n切换后"),"先校验镜像，再选择应用");
assert.equal(readablePreview("先校验镜像。\n再切换启动。\n失败"),"先校验镜像。\n再切换启动。");
console.log("Readable preview: 4 passed");
