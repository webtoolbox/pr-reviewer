const{app,BrowserWindow,ipcMain}=require('electron'),p=require('path'),fs=require('fs');
const diff=fs.readFileSync('/tmp/test-screenshot.diff','utf8');
['open-file','save-review','save-draft','load-draft','delete-draft','load-pr','open-pr-new-window'].forEach(h=>ipcMain.handle(h,async()=>null));
ipcMain.handle('save-image',async()=>null);
ipcMain.handle('list-prs',async()=>({prs:[]}));
ipcMain.handle('get-pr-commits',async()=>({commits:[],prUrl:'#'}));
ipcMain.handle('get-file-blame',async()=>({}));
ipcMain.handle('get-config',async()=>({aiTagPrefix:'@Hermes',repoOwner:'webtoolbox',repoName:'Website-Toolbox',editorCommand:'code',contextLines:5,diff:{excludeMerges:true},imageUpload:{enabled:false},cleanup:{enabled:true,retentionDays:180},rules:{enabled:false},autoFix:{enabled:false}}));
ipcMain.handle('open-file-in-editor',async()=>({success:true}));
ipcMain.handle('save-preferences',async()=>({success:true}));
ipcMain.handle('export-markdown',async()=>null);
ipcMain.handle('get-collaborators',async()=>[]);
app.whenReady().then(async()=>{
  const w=new BrowserWindow({width:1200,height:900,show:false,webPreferences:{preload:p.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  w.loadFile('index.html');
  w.webContents.on('did-finish-load',async()=>{
    await w.webContents.executeJavaScript('loadDiff('+JSON.stringify(diff)+')');
    await new Promise(r=>setTimeout(r,3000));
    await w.webContents.executeJavaScript('openPreferences()');
    await new Promise(r=>setTimeout(r,300));
    let img=await w.capturePage();
    fs.writeFileSync('/Users/sandeep/Repos/pr-reviewer/screenshots/preferences.jpg',img.toJPEG(90));
    console.log('done');
    app.exit(0);
  });
});
app.on('window-all-closed',()=>app.quit());
