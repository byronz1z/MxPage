const {spawn}=require('node:child_process');
const path=require('node:path');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),[path.resolve(__dirname,'../tests/desktop/agent-native.cjs')],{env,windowsHide:true,stdio:'inherit'});
child.on('exit',code=>{process.exitCode=code||0;});
