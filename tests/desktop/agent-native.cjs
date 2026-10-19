// Real, opt-in desktop acceptance. Uses only a disposable test app and directory.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const wait = ms => new Promise(r=>setTimeout(r,ms));
let window, client, directory, failed=false;
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'mx-agent-native-'));
  app.setAccessibilitySupportEnabled(true);
  ipcMain.on('test-save',(_event,text)=>{void fs.writeFile(path.join(directory,'result.txt'),String(text),'utf8');});
  window=new BrowserWindow({width:640,height:420,title:'MxPage Agent Acceptance Fixture',webPreferences:{contextIsolation:false,nodeIntegration:true}});
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>MxPage Agent Acceptance Fixture</title><style>body{font:18px system-ui;padding:30px}textarea{width:95%;height:140px;font:18px system-ui}button{padding:12px}</style><h1>Agent 桌面验收测试应用</h1><textarea aria-label="测试内容" autofocus></textarea><button onclick="require('electron').ipcRenderer.send('test-save',document.querySelector('textarea').value)">保存测试文件</button>`));
  window.show();window.focus();
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  client=new Client({name:'MxPageNativeAcceptance',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('node_modules/@zavora-ai/computer-use-mcp/dist/launch.js')],env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,ELECTRON_RUN_AS_NODE:'1',COMPUTER_USE_PROFILE:'ax',COMPUTER_USE_STATUS_CARD:'false'},stderr:'pipe'});
  transport.stderr?.on('data',()=>{});await client.connect(transport);
  const unpack=result=>{if(result.structuredContent)return result.structuredContent;for(const item of result.content||[])if(item.type==='text'){try{return JSON.parse(item.text)}catch{}}return{};};
  const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args},undefined,{timeout:20000});if(result.isError)throw Error(JSON.stringify(result));return result;};
  const windows=unpack(await call('list_windows'));const target=windows.windows.find(w=>String(w.title).includes('MxPage Agent Acceptance Fixture'));
  assert.ok(target,'Test window not discovered');const id=target.windowId;
  await call('get_ui_tree',{window_id:id,max_depth:10});
  // Let the real-user guard settle; do not bypass it with force.
  await wait(2500);
  window.setAlwaysOnTop(true); window.show(); window.moveTop(); window.focus();
  await call('activate_window',{window_id:id,timeout_ms:5000});
  await wait(500);
  const typed=await call('type',{text:'MxPage desktop acceptance 中文 123',target_window_id:id,target_app:target.bundleId,focus_strategy:'strict',force:false});
  const text=await window.webContents.executeJavaScript('document.querySelector("textarea").value');
  assert.equal(text,'MxPage desktop acceptance 中文 123',JSON.stringify(typed));
  await call('key',{text:'tab',target_window_id:id,target_app:target.bundleId,focus_strategy:'strict'});
  await call('key',{text:'return',target_window_id:id,target_app:target.bundleId,focus_strategy:'strict'});
  for(let i=0;i<40;i++){if(await fs.stat(path.join(directory,'result.txt')).catch(()=>null))break;await wait(100);}
  assert.equal(await fs.readFile(path.join(directory,'result.txt'),'utf8'),text);
  const screenshot=await call('screenshot',{target_window_id:id,quality:0,width:800});assert.ok(screenshot.content.some(c=>c.type==='image'));
  await fs.mkdir(path.resolve('test-output/agent-native'),{recursive:true});
  await fs.writeFile(path.resolve(`test-output/agent-native/${process.platform}-${process.arch}.json`),JSON.stringify({platform:process.platform,arch:process.arch,electron:process.versions.electron,driver:'7.6.1',testedAt:new Date().toISOString(),passed:['discover test window','accessibility tree','type Chinese text','save through GUI','verify saved file','targeted screenshot']},null,2));
  console.log('PASS native desktop input, save and verification',process.platform,process.arch);
}).catch(error=>{console.error(error);failed=true;}).finally(async()=>{await client?.close().catch(()=>{});window?.destroy();if(directory&&path.dirname(directory)===path.resolve(os.tmpdir())&&path.basename(directory).startsWith('mx-agent-native-'))await fs.rm(directory,{recursive:true,force:true});app.exit(failed?1:0);});
