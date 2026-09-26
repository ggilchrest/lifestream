import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const result=spawnSync('npx',['cap','sync','ios'],{stdio:'inherit'});if(result.status)process.exit(result.status);
const path=new URL('../ios/App/CapApp-SPM/Package.swift',import.meta.url);let text=await readFile(path,'utf8');
text=text.replace('dependencies: [\n        .package','dependencies: [\n        .package(path: "../../../native"),\n        .package').replace('dependencies: [\n                .product','dependencies: [\n                .product(name: "AssistantCore", package: "native"),\n                .product');
await writeFile(path,text);
