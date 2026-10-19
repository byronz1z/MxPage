const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { randomUUID, createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for(let i=0;i<300;i++){if(await fn())return;await sleep(200);}throw Error('Browser check timed out'); }
(async()=>{
  process.chdir(path.resolve(__dirname,'../..'));
  const runId=randomUUID(), dist=`.next-browser-${runId}`, config=`.browser-tsconfig-${runId}.json`;
  fs.copyFileSync('tsconfig.json',config); fs.mkdirSync('test-output/agent-browser',{recursive:true});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mx-agent-browser-')), filename=path.join(directory,'test.db');
  const sqlite=new DatabaseSync(filename);
  for(const entry of fs.readdirSync('prisma/migrations',{withFileTypes:true}).filter(e=>e.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name)))sqlite.exec(fs.readFileSync(path.join('prisma/migrations',entry.name,'migration.sql'),'utf8'));sqlite.close();
  const databaseUrl=`file:${filename.replaceAll('\\','/')}`, db=new PrismaClient({datasourceUrl:databaseUrl});
  const calls=[];
  const plan={goal:'整理资料并导出研究文档',steps:['整理研究要点','导出 Markdown 文档'],tools:['export_document'],fileIds:[],projectIds:[],applications:[],directories:[],generationCount:0,estimatedCost:'按实际文本用量计费',permissions:['保存到会话目录']};
  const upstream=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    if(req.method==='GET'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:'agent-model-A'}]}));}
    const input=JSON.parse(body);calls.push(input);
    const messages=input.messages||[];let content='你好，我可以帮你完成研究和文件处理。',tool;
    if(messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('研究文档'))){
      if(messages.some(m=>m.tool_call_id==='export_browser'))content='研究文档已经导出，可在成果面板下载。';
      else if(messages.some(m=>m.tool_call_id==='plan_browser'))tool={id:'export_browser',name:'export_document',args:{name:'研究文档',format:'md',content:'# 研究文档\n\n浏览器验收产物。'}};
      else tool={id:'plan_browser',name:'propose_plan',args:plan};
    }
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:`browser_mock_${calls.length}`,object:'chat.completion',created:1,model:input.model,choices:[{index:0,finish_reason:tool?'tool_calls':'stop',message:{role:'assistant',content:tool?'':content,...tool?{tool_calls:[{id:tool.id,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{}}}],usage:{prompt_tokens:20,completion_tokens:20,total_tokens:40}}));
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const baseUrl=`http://127.0.0.1:${upstream.address().port}`, key='browser-agent-test-only';
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const fingerprint=createHash('sha256').update(key).digest('hex');
  await db.providerConfig.create({data:{name:'Mock Agent',baseUrl,apiKeyEncrypted:'',isActive:true,models:{create:{modelId:'agent-model-A',label:'测试模型 A',roles:{},isDefaultPlanning:true,capabilities:{text:true,vision:true,__agentTools:{key:hash([`${baseUrl}/v1`,'agent-model-A',fingerprint]),protocol:'chat_completions',streaming:false,verifiedAt:new Date().toISOString()}}}}}});
  const port=await new Promise(r=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const n=server.address().port;server.close(()=>r(n));});});const url=`http://127.0.0.1:${port}`;
  const log=fs.openSync('test-output/agent-browser/server.log','w');
  const server=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port',String(port)],{windowsHide:true,stdio:['ignore',log,log],env:{...process.env,DATABASE_URL:databaseUrl,STORAGE_ROOT:path.join(directory,'storage'),NEXT_DIST_DIR:dist,MXPAGE_TEST_TSCONFIG:config,LOCK_BASE_URL:baseUrl,FORCED_API_BASE:baseUrl,NEXT_TELEMETRY_DISABLED:'1'}});
  let browser;
  try{
    await until(async()=>{try{return(await fetch(`${url}/agent`)).ok;}catch{return false;}});
    browser=await chromium.launch({...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:fs.existsSync(chromium.executablePath())?{}:{channel:'chrome'}),headless:true,args:['--no-proxy-server']});const page=await browser.newPage({viewport:{width:1600,height:1050}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(({key,baseUrl})=>localStorage.setItem('mxpage:provider-credentials:v1',JSON.stringify({apiKey:key,baseUrl})),{key,baseUrl});
    await page.goto(`${url}/agent`);await page.getByRole('heading',{name:'Agent 工作台',exact:true}).waitFor();
    const nav=page.getByRole('navigation',{name:'主导航',exact:true});assert.deepEqual((await nav.locator('a').allTextContents()).slice(0,2),['Agent 工作台','一键详情页']);
    await page.getByLabel('发送消息',{exact:true}).fill('请整理研究文档并导出');await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.getByRole('button',{name:'确认方案并执行',exact:true}).waitFor({timeout:60000});
    assert.equal(await db.agentArtifact.count(),0);assert.equal(calls.length,1);
    await page.reload();await page.getByRole('button',{name:'请整理研究文档并导出',exact:true}).click();
    await page.getByRole('button',{name:'确认方案并执行',exact:true}).click();
    await page.getByText('研究文档已经导出，可在成果面板下载。',{exact:true}).waitFor({timeout:60000});
    const download=page.getByRole('link',{name:'下载 研究文档.md',exact:true});await download.waitFor();
    assert.equal((await fetch(url+await download.getAttribute('href'))).status,200);
    assert.equal(await db.agentArtifact.count(),1);assert.ok(calls.every(c=>c.model==='agent-model-A'));
    await page.getByRole('heading', { name: '费用记录（USD）', exact: true }).waitFor();
    await page.getByRole('button',{name:'预览 研究文档.md',exact:true}).click();
    await page.getByRole('dialog').getByText('浏览器验收产物。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'关闭预览',exact:true}).click();
    await page.screenshot({path:'test-output/agent-browser/desktop.png',fullPage:true});
    await page.getByLabel('重命名会话',{exact:true}).click();await page.getByLabel('会话名称').fill('研究验收');await page.getByRole('button',{name:'保存',exact:true}).click();
    await until(async()=>Boolean(await db.agentSession.findFirst({where:{title:'研究验收'}})));
    await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'计划与成果',exact:true}).click();await page.getByRole('heading',{name:'计划与成果',exact:true}).waitFor();
    await page.screenshot({path:'test-output/agent-browser/mobile.png',fullPage:true});await page.getByRole('button',{name:'关闭',exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'mobile overflow');
    await page.goto(`${url}/settings/agent`);await page.getByRole('heading',{name:'Agent 设置',exact:true}).waitFor();await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText('已保存。新任务使用新设置，已有任务继续使用原快照。',{exact:true}).waitFor();
    assert.deepEqual(errors,[]);console.log('PASS Agent browser: navigation, confirmation, refresh, document download, rename, mobile drawers, settings');
  }catch(error){
    if(browser){const pages=browser.contexts().flatMap(c=>c.pages());if(pages[0]){await pages[0].screenshot({path:'test-output/agent-browser/failure.png',fullPage:true});fs.writeFileSync('test-output/agent-browser/failure.txt',await pages[0].locator('body').innerText());}}
    fs.writeFileSync('test-output/agent-browser/runs.json',JSON.stringify(await db.agentRun.findMany(),null,2));
    fs.writeFileSync('test-output/agent-browser/calls.json',JSON.stringify({requests:calls,ledger:await db.agentToolCall.findMany()},null,2));
    throw error;
  }finally{
    await browser?.close();if(process.platform==='win32')spawnSync('taskkill',['/pid',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else server.kill('SIGTERM');
    await db.$disconnect();upstream.close();fs.closeSync(log);
    for(const item of [dist,config]){const resolved=path.resolve(item);if(path.dirname(resolved)!==process.cwd()||!item.includes(runId))throw Error('Invalid cache cleanup');fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
    if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('mx-agent-browser-'))throw Error('Invalid fixture cleanup');fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1});
