import {readFileSync,writeFileSync} from 'node:fs';
const version=process.argv[2] || JSON.parse(readFileSync('package.json','utf8')).version;
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Expected a stable version such as 1.0.11');
for(const file of ['package.json','package-lock.json','src-tauri/tauri.conf.json']){
  const data=JSON.parse(readFileSync(file,'utf8'));data.version=version;
  if(file==='package-lock.json')data.packages[''].version=version;
  writeFileSync(file,JSON.stringify(data,null,2)+'\n');
}
for(const file of ['src-tauri/Cargo.toml','src-tauri/Cargo.lock']){
  const text=readFileSync(file,'utf8');
  const pattern=file.endsWith('.lock') ? /(name = "interview-cue"\r?\nversion = ")[^"]+/ : /(^version = ")[^"]+/m;
  if(!pattern.test(text))throw new Error(`Application version not found: ${file}`);
  writeFileSync(file,text.replace(pattern,`$1${version}`));
}
console.log(`Application versions synchronized to ${version}`);
