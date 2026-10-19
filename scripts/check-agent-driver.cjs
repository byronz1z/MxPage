const fs = require('node:fs');
const path = require('node:path');
(async()=>{
  const root=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'..');
  const packageRoot=path.join(root,'node_modules/@zavora-ai/computer-use-mcp');
  const metadata=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8'));
  if(metadata.version!=='7.6.1')throw Error('Unexpected desktop driver version');
  const {pathToFileURL}=require('node:url');
  const {loadNative,resolveAddonPath}=await import(pathToFileURL(path.join(packageRoot,'dist/native.js')).href);
  const native=loadNative();
  for(const method of ['getUiTree','typeText','takeScreenshot','getInputMonitorCapability'])if(typeof native[method]!=='function')throw Error(`Missing native capability: ${method}`);
  console.log(JSON.stringify({driver:metadata.version,target:`${process.platform}-${process.arch}`,binary:path.basename(resolveAddonPath()),inputMonitor:native.getInputMonitorCapability(),guiAcceptance:'not performed by this packaging check'}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
