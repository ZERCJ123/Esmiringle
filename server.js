const express=require('express'),http=require('http'),path=require('path'),fs=require('fs'),crypto=require('crypto');
const {Server}=require('socket.io');
const app=express(),server=http.createServer(app);
const io=new Server(server,{maxHttpBufferSize:6e6});
const ADMIN_USER=process.env.ADMIN_USER||'admin', ADMIN_PASS=process.env.ADMIN_PASS||'change-me';
const BASE=process.env.DATA_DIR||__dirname; const UP=path.join(BASE,'uploads'), DATA=path.join(BASE,'data.json');
fs.mkdirSync(UP,{recursive:true});
let db={chats:{},banned:[]};
try{db=JSON.parse(fs.readFileSync(DATA))}catch{}
const save=()=>fs.writeFile(DATA,JSON.stringify(db),()=>{});

function auth(req,res,next){
  const [u,p]=Buffer.from((req.headers.authorization||'').split(' ')[1]||'','base64').toString().split(':');
  if(u===ADMIN_USER&&p===ADMIN_PASS)return next();
  res.set('WWW-Authenticate','Basic realm="admin"').status(401).send('Auth required');
}
app.use(express.static(path.join(__dirname,'public')));
app.use('/admin',auth,express.static(path.join(__dirname,'admin')));
app.use('/admin/uploads',auth,express.static(UP));
app.get('/admin/api/chats',auth,(req,res)=>res.json(Object.values(db.chats).sort((a,b)=>b.started-a.started).slice(0,300)));
app.post('/admin/api/ban/:ip',auth,(req,res)=>{ if(!db.banned.includes(req.params.ip))db.banned.push(req.params.ip); save();
  for(const [,s] of io.sockets.sockets) if(s.ip===req.params.ip){s.emit('banned');s.disconnect(true);} res.json({ok:true}); });

let waiting=[];
const IMG={'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp'};
function endChat(s,notify=true){
  waiting=waiting.filter(x=>x!==s);
  const p=s.partner; s.partner=null;
  if(p){p.partner=null; if(notify)p.emit('partner_left');}
}
function match(s){
  endChat(s,false);
  const i=waiting.findIndex(w=>w!==s&&!(s.blocked.has(w.ip))&&!(w.blocked.has(s.ip)));
  if(i<0){waiting.push(s);return s.emit('waiting');}
  const p=waiting.splice(i,1)[0];
  const id=crypto.randomUUID();
  s.partner=p;p.partner=s;s.chatId=p.chatId=id;
  db.chats[id]={id,started:Date.now(),flagged:false,users:[{nick:s.nick,ip:s.ip},{nick:p.nick,ip:p.ip}],messages:[]};
  save(); s.emit('matched',{partner:p.nick}); p.emit('matched',{partner:s.nick});
}
function log(s,entry){const c=db.chats[s.chatId]; if(c){c.messages.push({t:Date.now(),from:s.nick,ip:s.ip,...entry});save();}}

io.on('connection',s=>{
  s.ip=(s.handshake.headers['x-forwarded-for']||s.handshake.address||'').split(',')[0].trim();
  s.blocked=new Set(); s.last=0;
  if(db.banned.includes(s.ip)){s.emit('banned');return s.disconnect(true);}
  s.on('join',d=>{
    if(!d||d.adult!==true)return s.emit('need18');
    s.nick=String(d.nick||'Anon').replace(/[<>]/g,'').slice(0,20)||'Anon'; match(s);
  });
  s.on('msg',text=>{
    if(!s.partner||Date.now()-s.last<300)return; s.last=Date.now();
    text=String(text||'').slice(0,2000); if(!text.trim())return;
    log(s,{text}); s.partner.emit('msg',{from:s.nick,text});
  });
  s.on('media',({mime,data})=>{
    if(!s.partner||!IMG[mime]||!data||data.length>5e6)return;
    const buf=Buffer.from(data);
    const name=crypto.randomUUID()+'.'+IMG[mime]; fs.writeFile(path.join(UP,name),buf,()=>{});
    log(s,{media:name}); s.partner.emit('media',{from:s.nick,mime,data});
  });
  s.on('report',()=>{ const c=db.chats[s.chatId]; if(c){c.flagged=true;save();} });
  s.on('block',()=>{ if(s.partner)s.blocked.add(s.partner.ip); });
  s.on('next',()=>match(s));
  s.on('disconnect',()=>endChat(s));
});
server.listen(process.env.PORT||3000,()=>console.log('Running on http://localhost:'+(process.env.PORT||3000)+'  admin: /admin'));
