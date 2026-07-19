const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const IS_CLOUD = process.env.CLOUD === 'true' || process.env.RENDER === 'true';
let key, cert;
if (!IS_CLOUD) {
  const forge = require('node-forge');
  function generateSelfSignedCert() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
    
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    
    cert.setExtensions([{
      name: 'subjectAltName',
      altNames: [{ type: 2, value: 'localhost' }, { type: 2, value: '*.u3635584.nyat.app' }]
    }]);
    
    cert.sign(keys.privateKey);
    return {
      key: forge.pki.privateKeyToPem(keys.privateKey),
      cert: forge.pki.certificateToPem(cert)
    };
  }
  const result = generateSelfSignedCert();
  key = result.key;
  cert = result.cert;
}
const app = express();
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, path) => {
    if (path.endsWith('.gif')) {
      res.setHeader('Content-Type', 'image/gif');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (path.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.use('/drawable', express.static(path.join(__dirname, 'drawable'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.gif')) {
      res.setHeader('Content-Type', 'image/gif');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      res.removeHeader('Content-Encoding');
    }
  }
}));

let httpsServer, httpServer;
if (IS_CLOUD) {
  httpServer = http.createServer(app);
} else {
  httpsServer = https.createServer({
    key,
    cert,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    ciphers: 'HIGH:!aNULL:!MD5'
  }, app);
  httpsServer.on('tlsClientError', (err) => {});
  httpServer = http.createServer(app);
}

const io = new Server({
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 20000,
  pingInterval: 60000
});
if (IS_CLOUD) {
  io.attach(httpServer);
} else {
  io.attach(httpsServer);
  io.attach(httpServer);
}

let yingmoPosition = null;

if (!IS_CLOUD) {
  httpsServer.on('tlsClientError', (err) => {
    if (!err.message.includes('socket hang up')) {
      console.log('⚠️ TLS 错误:', err.message);
    }
  });
}

const BOARD_SIZE = 36;
const PASS_GO_REWARD = 200;

function previewMoney(playerId, amount) {
  const player = players.find(p => p.id === playerId);
  if (!player) return;
  if (amount < 0) {
    // 扣钱：发动画 + 扣款
    deductMoney(playerId, -amount);
    return;
  }
  // 加钱：发动画 + 加款同时进行
  io.emit('moneyChangePreview', { playerId, amount });
  player.money += amount;
}

// 临时金钱相关函数
function grantTempMoney(playerId, amount, turns) {
  const player = players.find(p => p.id === playerId);
  if (!player) return;
  if (!player.tempMoney) player.tempMoney = 0;
  if (!player.tempTurns) player.tempTurns = 0;
  player.tempMoney += amount;
  player.tempTurns = turns;
}

// 统一扣钱函数，优先使用临时金钱
function deductMoney(playerId, amount) {
  const player = players.find(p => p.id === playerId);
  if (!player) return false;
  
  doDeduct(playerId, amount);
  return true;
}

function doDeduct(playerId, amount) {
  const player = players.find(p => p.id === playerId);
  if (!player) return;
  
  // 保护卡不再保护现金，直接扣款
  
  let remaining = amount;
  
  // 优先使用临时金钱
  if (player.tempMoney && player.tempMoney > 0) {
    const tempUsed = Math.min(remaining, player.tempMoney);
    io.emit('moneyChangePreview', { playerId, amount: -tempUsed });
    player.tempMoney -= tempUsed;
    remaining -= tempUsed;
    
    // 临时金钱用完了就消失
    if (player.tempMoney <= 0) {
      player.tempMoney = 0;
      player.tempTurns = 0;
    }
  }
  
  // 剩余部分用自己的钱
  if (remaining > 0) {
    io.emit('moneyChangePreview', { playerId, amount: -remaining });
    player.money -= remaining;
  }
  
  return true;
}

// 获取玩家M2显示的金钱（优先显示临时金钱）
function getDisplayMoney(player) {
  if (player.tempMoney && player.tempMoney > 0) return player.tempMoney;
  return player.money;
}

// 虚拟监狱格子 ID
const JAIL_ISLAND_ID = 37;
const JAIL_HOSPITAL_ID = 38;
const JAIL_JAIL_ID = 39;
const JAIL_FREE_ID = 40;

const moneyTable = { 6: 150, 5: 180, 4: 225, 3: 300, 2: 450, 1: 900 };


function getPropertySpaceIds() {
  return board.filter(s => s.isProperty).map(s => s.id);
}

// 获取可停业的地产格子(无主或非当前玩家拥有)
function getAvailablePropertySpaceIds(excludePlayerId = null) {
  return board.filter(s => s.isProperty && (!s.owner || s.owner !== excludePlayerId)).map(s => s.id);
}

function getRandomPropertyIds(count, excludeIds = []) {
  const available = getPropertySpaceIds().filter(id => !excludeIds.includes(id));
  const shuffled = available.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

const cardData = [
  { id: 1, name: '抢劫卡', description: '抢劫卡：与他人拼钱，若胜抢夺7/卡', image: 'qiangjie' },
  { id: 2, name: '乌龟卡', description: '乌龟卡：令所有他人掷1', image: 'wugui' },
  { id: 4, name: '保护卡', description: '保护卡：地产被他人选中后，保护一次地产', image: 'baohu' },
  { id: 5, name: '免休卡', description: '免休卡：免除休息1次', image: 'mianxiu' },
  { id: 6, name: '隐藏卡', description: '隐藏卡：成为目标时触发，效果仅卡主可见', image: 'yincang' },
  { id: 61, name: '隐藏卡·抵消', description: '隐藏卡·抵消：令其他玩家的主动卡无效', image: 'yincang', hiddenType: 'dixiao', hiddenBase: true },
  { id: 62, name: '隐藏卡·取消', description: '隐藏卡·取消：成为他人目标后，取消此次目标', image: 'yincang', hiddenType: 'quxiao', hiddenBase: true },
  { id: 63, name: '隐藏卡·减源', description: '隐藏卡·减源：成为他人目标后，来源-9', image: 'yincang', hiddenType: 'jianyuan', hiddenBase: true },
  { id: 64, name: '隐藏卡·转移', description: '隐藏卡·转移：成为他人目标后，你更改目标', image: 'yincang', hiddenType: 'zhuanyi', hiddenBase: true },
  { id: 65, name: '隐藏卡·反弹', description: '隐藏卡·反弹：成为他人目标后，将效果反弹给来源', image: 'yincang', hiddenType: 'fantan', hiddenBase: true },
  { id: 7, name: '骰子1', description: '掷1', image: 'touzi1' },
  { id: 8, name: '骰子2', description: '掷2', image: 'touzi2' },
  { id: 9, name: '骰子3', description: '掷3', image: 'touzi3' },
  { id: 13, name: '钥匙', description: '钥匙：一把钥匙，可以用来开门', image: 'yaoshi' },
  { id: 14, name: '炸弹卡', description: '炸弹卡：正上方放置2回合的延时炸弹，踩中-24并进医院，本排的人-4并休息1回合', image: 'zhadan' },
  { id: 15, name: '传送卡', description: '传送卡：令传送到任意位置', image: 'chuansong' },
  { id: 16, name: '倒退卡', description: '倒退卡：令所有人倒退1回合', image: 'daotui' },
  { id: 17, name: '建房卡', description: '建房卡：免费建房1次/令当前排所有地产路费+2', image: 'jianfang' },
  { id: 18, name: '免路费卡', description: '免路费卡：免除路费1次/令当前排的地产停业', image: 'mianlufei' },
  { id: 19, name: '龙卷风卡', description: '龙卷风卡：令休息2回合且不可选取', image: 'longjuanfeng' },
  { id: 20, name: '冰冻卡', description: '冰冻卡：令停留1回合', image: 'bingdong' },
  { id: 21, name: '停业卡', description: '停业卡：令某人全部地产停业', image: 'tingye' },
  { id: 22, name: '闪现卡', description: '闪现卡：前/后位移1-3格，落点令其他人随机弹飞', image: 'shanxian' },
  { id: 23, name: '强拆卡', description: '强拆卡：令当前房屋降级', image: 'qiangchai' },
  { id: 24, name: '征地卡', description: '征地卡：给地主等量地屋钱占领此地', image: 'zhengdi' },
  { id: 26, name: '黑客卡', description: '黑客卡：与他人拼钱，若胜获得其全部冻结的钱', image: 'heike' },
  { id: 27, name: '多功能卡', description: '多功能卡：路费减少10/重新判定1次/重新抽机遇', image: 'duogongneng' },
  { id: 28, name: '彩色骰子', description: '彩色骰子：比普通骰子强一点', image: 'caisetouzi' },
  { id: 29, name: '路障卡', description: '路障卡：放置在前/后6格任一格，令经过的人强制停下', image: 'luzhang' },
  { id: 30, name: '净化卡', description: '净化卡：令某人清除所有状态', image: 'jinghua' },
  { id: 31, name: '封地卡', description: '封地卡：令不能买地和建房3回合', image: 'fengdi' },
  { id: 32, name: '睡眠卡', description: '睡眠卡：令休息3回合', image: 'shuimian' },
  { id: 33, name: '陷害卡', description: '陷害卡：令进监狱', image: 'xianhai' },
  { id: 34, name: '古董卡', description: '古董卡：当前价格1，每轮价格+1，点击使用即卖出', image: 'gudong', price: 1 },
];

const hiddenSubTypes = [61, 62, 63, 64, 65];

function getRandomCard() {
  const normalCards = cardData.filter(c => !c.hiddenBase);
  return normalCards[Math.floor(Math.random() * normalCards.length)];
}

function addCardToPlayer(player, card) {
  if (!player.cards) player.cards = [];
  if (card.id === 6) {
    const subId = hiddenSubTypes[Math.floor(Math.random() * hiddenSubTypes.length)];
    const subCard = cardData.find(c => c.id === subId);
    if (subCard) {
      player.cards.push({ ...subCard });
    }
  } else if (card.id === 28) {
    const colorDiceTypes = [
      { name: '掷两个骰子，二选一作为落点', description: '掷两个骰子，二选一作为落点', image: 'caisetouzi', isColorDice: true, diceType: 'chooseOne' },
      { name: '两个骰子和作为点数', description: '两个骰子和作为点数', image: 'caisetouzi', isColorDice: true, diceType: 'sum' },
      { name: '掷的点数+2，获得等量金钱', description: '掷的点数+2，获得等量金钱', image: 'caisetouzi', isColorDice: true, diceType: 'moneyPlus' },
      { name: '连续动2次', description: '连续动2次', image: 'caisetouzi', isColorDice: true, diceType: 'extraTurn' },
      { name: '自选点数', description: '自选点数', image: 'caisetouzi', isColorDice: true, diceType: 'choose' }
    ];
    const randomType = colorDiceTypes[Math.floor(Math.random() * colorDiceTypes.length)];
    player.cards.push({ ...randomType });
  } else {
    player.cards.push({ ...card });
  }
}

// 宠物信息映射：文件名 → { name, desc }
const petInfoMap = {};
(function(){
  const data = [
    ['福星高照猪','状态改为判定：4休息1回合，5无效，6翻面并获得随机卡'],
    ['夏蝉','骰子前3次存起来，第4次一起动'],
    ['恶狼','令到你地产的选择：给你4/下次给你10'],
    ['寒冰猛犸','冻住当前排的他人，直到判大点；没有他人则冻住自己'],
    ['美猴王','召唤猴王，掷后选其中一个行动，4回合后猴王消失'],
    ['混沌','同排的他人施加灾厄'],
    ['神速蜗牛','限2次，令所有人掷小点'],
    ['锦鲤','重新判定；重抽机遇'],
    ['猎豹','骰子数量+1'],
    ['穷奇','与地主拼钱，胜掠夺其10%现金，否则翻面'],
    ['汗血马','掷前将点数1和2改为7'],
    ['青龙','与地主拼钱，胜得地产，否则失去青龙'],
    ['百足虫','掷1/掷小点/再动1次/点数+1，每项限选1次'],
    ['吸血蚊','令他人回合开始选择：给你1/-4判小点令翻面/给你6令翻面'],
    ['变色龙','掷6改为自选点数'],
    ['和平熊猫','交路费后，用此卡交换你当前空地'],
    ['毒蛇','令地主点数上限-2(失去的点数改为休息，然后上限+1)'],
    ['睡眠树懒','掷5-6改为休息1回合并+5'],
    ['细胞','生成两只宠物，二选一，失去此宠物'],
    ['白虎','交路费前，地主给你$2-4，猜对免交'],
    ['蜇人蜂','选某地产并给地主4，令其选择：-10/该地停业'],
    ['影魔','限3次，操纵影子，与人互换位置'],
    ['杂草','令某地产停业并生成路障，此卡退回'],
    ['青鸾','点数≥上轮，得2-4-8...32-32，小于中断'],
     ['瘟疫鼠','生成唯1瘟疫鼠，交给非本卡玩家的地主并拼钱，输-4'],
    ['幻鹿','成为目标时，在本区域生成幻影，来源2选1，若选中本体，此卡退回'],
    ['机器人','起点随机地卡升级，此卡退回'],
    ['玄武','3回合后生成被动护盾，抵消1次强制效果/路费'],
    ['恐龙','缴费前令路费-2，此卡退回'],
    ['钢刺猬','失钱后令来源判定1-3:令其后退1-3格；4:休息1回合；5:-5'],
    ['仙鹤','绑定本区域某格，设置唯1丹朱，银行替你失去钱直到他人到丹朱'],
    ['僵尸','与地主拼钱若胜，判定1-5作为其骰子直到你/其到起点'],
    ['一拳超熊','将地主打飞到随机格'],
    ['魔蝎','将本区域他人拉到你格，休息1回合后失控1回合；相邻区域向你拉一格'],
    ['史莱姆','异区域生成两个史莱姆；可炸开，将区域里的人击退至与史莱姆距离6'],
    ['骷髅','给地主的钱后令其冻结14'],
    ['饕餮','得钱改为从银行得5倍，此后不再得钱'],
    ['独角兽','失去此卡时，抽奇遇，然后到任意地'],
    ['鸡肋','强占宠物格；起点判1-3给他人，4-5不退回'],
    ['美人鱼','在海岛随机飞改为给你5；令地主生成3回合唯1水圈，可+10进海岛，到你地卡-30且必进'],
    ['泰坦','任意格失效并搬来一座巨山：经过的他人强制停留此格，判5-6解除'],
    ['萨满','拼钱给你路费的人若胜，使其结束最多距你3，每回合给你2'],
    ['跳蚤','每回合限1次，到地产格改为再掷一次，偶数往前跳，奇数往后跳'],
    ['结网蜘蛛','令经过你地卡的剩余点数-1'],
    ['候鸟','绑定两格，互为传送口；他人传送后眩晕1回合'],
    ['蟹老板','生成钳子，可在某区域来回1格移动，若移动前后夹住人，将其拉到你格休息1回合，你+6'],
    ['深渊鲨鱼','潜伏某3格，3回合后令进入他人-20并进医院，冷却3回合'],
    ['魅惑菇','令地主下回合逆行'],
    ['潜水鳄鱼','绑定某地卡路费*2，你的其他地产卡停业'],
    ['秃鹫','破产者拍卖前，从资产中随机获得1个'],
    ['长跑龟','令掷小点，下个开始令同区域的休息1回合，否则你休息'],
    ['守卫狮鹫','拼钱，赢不交过路费，否则获得对方拼的钱'],
    ['八岐大蛇','拼交路费的人，胜再收取8，否则获得对方拼的钱'],
    ['蛇发女妖','令地主选第三人决斗，先后-2，否则石化直到判5-6'],
    ['南洋大兜虫','给地主建房费令其降级，建房时用此卸下升级，若没卸下的将退还'],
    ['滑泥鳅','直接到下个非地产格子，他人可抓你回经过格子。（两拼钱，输失效）'],
    ['谛听','$5悬赏金通缉唯1他人，任何人交路费前可与其拼钱，若胜将其送监狱'],
    ['灾害蝗虫','给地主的钱中，前后两格各掉落2，然后路费-1；场上至多6片'],
    ['大鹏鸟','若掷4-6，令前/后的人后退1-3格；令他人在绑定区域内的点数-2'],
    ['猞猁','与地主拼钱，赢换他人交，否则获得对方拼的钱'],
    ['小雏菊','与进休息期的换宠物'],
    ['四不像','与地主拼钱并获得他的钱，输的宠物退回'],
    ['缚绞藤蔓','给3将他人捆住，其3回合若没掷大点，将被禁足，直到判6'],
    ['病毒蝙蝠','指定/成为目标或缴路费后，对方感染1病毒（每回合-$毒数，医院清零）'],
    ['曼陀罗花','到你地卡的选择：退回掷前/随机抽你的9，给你6，长眠直到有人到同格'],
    ['学舌鹦鹉','取消下轮骰子，给任意人3，复制其中1个点数'],
    ['电鳗','往前/后方向朝地主放电，途经直到地主失去2-4-6'],
    ['泡泡水母','随机4格选2装上水牢：他人掷小点被拉回原地'],
    ['萌萌兔','每回合限1次，$5重新判定；重掷骰子'],
    ['千年树','停在本格修炼，5回合后+50且前进7格，有人经过将-20且修炼失败'],
    ['夔','给每人3，闭眼选择退回/收下，若收下的人数≥一半，偶数+6，奇数改为连续3次1'],
    ['金丝雀','3回合后，封闭某区域3回合，区域内只能来回移动，区域外的人撞晕'],
    ['丁香花','他人结束$9令其判定，1-3后退到掷前，4-5退7格，6退回起点'],
    ['红色蒲公英','随时$7改为随机落点'],
    ['食人花','绑定某格，将第一个到达的人吞掉后变成路障，第二个到达后此卡退回'],
    ['外星生物','掷后将你的区域入口改为随机另一个'],
    ['落叶','每回合1次，将失钱放在本格(可捡)，然后抽机遇，场上至多2落叶'],
    ['吸血鬼','与进休息期的拼钱，他输后只能选自己为目标，否则拼的钱给你'],
    ['藏獒','地和房不能被他人选中'],
    ['含羞草','随机4格，选2绑定：有人经过后，令下次只能掷小点经过，否则停留'],
    ['夜来香','他人进休息期后，免疫失钱的再动一次'],
    ['金银花','起点随机他人，可令现金和其一样'],
    ['七里香','选他人，1回合后计算距离，同区每1格各+2，相邻区域各+2'],
    ['克苏鲁','用钱时暗置，他人可质疑。真，每个质疑者给你钱÷质疑人数；假，反之'],
    ['昙花','加2辅助骰子，相同数3:缓存提现；1:缓存点数；2:缓存点数*5；起点-90%缓存'],
    ['深海巨鳗','掷前+50，结束-55（不足归零）'],
    ['贷鼠','支付时从银行贷款，起点还50%'],
    ['河童','起点随机一人，可令其和你现金一样'],
    ['三叶草','往前/后扔出6步/回合三叶草，2回合后6步/回合回你手中，经过的人-3'],
    ['精灵女王','点数上限+1，扔2骰子，自由安排下2回的顺序'],
    ['未知生物','令他人选目标时随机'],
    ['高维生物','标记地主，他人只能选其为目标直到其失钱'],
    ['未来生物','掷前$5生成未来护盾抵消第1次失钱/强制效果，下回合开始盾消失'],
    ['恶魔之子','令你破产的失去宠物格，卡包格，现金归零'],
    ['牛蛙','给非来源6复制对你的非失钱效果给他'],
    ['黄龙','猜对下个到起点的人，随机得1花色，否则失去，集齐四色抽奇遇'],
    ['藏羚羊','将骰子改为跳向前方≤5格他人，并再前进等距离'],
    ['断尾壁虎','结束压任意钱到某地卡，失去地卡后返3倍'],
    ['长颈鹿','结束现金补充到最近的5的倍数'],
    ['睚眦','成为目标后，令来源判3点-30'],
    ['大猩猩','限1次，随时花10不可选定，下回合跳任意某格，令区域每个他人晕1回合并给你5'],
    ['神秘生物','选1暗藏并划掉，用完刷新：1:与来源拼钱，他输-5 2:令他人掷6点改为0点 3:令同区域他人逆行1次'],
    ['精灵公主','扔2次2个骰子，选1组作为你下2回的点数'],
    ['韭菜','绑定1人成为韭菜，你和随机第3人闭眼1-5，韭菜看后选1个进贡2回合'],
    ['食尸鬼','每有一个人破产，+100；起点不退回'],
    ['梦蝶','限2次，标记本区域某格，掷后改为位移标记'],
    ['银狮子','第1区域时将任意钱冻结，到起点+30%(个位>3)'],
    ['鸳鸯','他人和你点数相同，选择：各得3/令其点数-1'],
    ['量子生物','掷后暗置并声明用某点数，他人可质疑。真，质疑者给你6；假反之且退回'],
    ['常青藤','起点经过额外+1工资，到达+2'],
    ['先知猫头鹰','猜测每人大小点，猜对得1-2-4..16-16...猜错中断'],
    ['发条魔灵','令球恢复原状并三选一：1.进/退1-2格，落点晕人 2.区域他人拉到球，收回 3.加速自己+减速他人'],
    ['海绵','绑定吸收某人10，其掷5-6索回，然后换人'],
    ['金鱼','指定目标/被指定后，一起+/-2'],
    ['彼岸花','限2次，掷后改为在对岸同向移动，结束可回来'],
    ['磁铁生物','令相邻区域他人与你一起弹开/吸拢一半距离'],
    ['海星','结束$1前/后位移1格'],
    ['灯笼鱼','掷前将某点数改为休息'],
    ['鬣狗','若某人现金≤20，掠夺其4'],
    ['奇美拉','选择目标时1真1假，他们选择是否执行，若真的选不执行，双倍执行'],
    ['巫妖王','令出局的成为你的亡灵，胜利条件与你一致，亡灵现金始终为0'],
    ['魔法生物','令某3格变成传送区，2回合后将到达的人传送到间距≤6格的3格到达区'],
    ['海豚','当有人对你使用卡时，你将其改为随机卡；起点将你的1张卡随机'],
    ['斑马','指定目标后令其铁索，某铁索失钱时，其他铁索解除并各失去50%'],
    ['火麒麟','宠物技能对你无效；起点自选1卡'],
    ['朱雀','令他人失钱时，区域内他人也失等量，相邻区域-50%；令地主-4'],
    ['惊虾','暗置惊吓盒子在任意格(场上至多2个)，他人踩中-5且失控1回合'],
    ['石头人','掷前令下回合往前撞6格，路径上有他人撞晕1回合，否则你晕'],
    ['貔貅','若你4个回合没有用钱，+10/回合，起点不退回'],
    ['蓝色妖姬','限2次，掷前标记本格并前/后位移1-2格，结束可返回标记'],
    ['星辰花','掷前$3-6-9在后1-3格生成飞星，结束砸向前1-3格，令路径上他人进医院并-人星距，前方-2倍'],
    ['贝壳','起点将卡兑换成彩色骰子/钻石，然后+1随机卡'],
    ['荨麻花','异区域生成两朵，掷前使用间隔≤1区域的花冲向你，你加速，路径上的他人进医院'],
    ['连翘','异区域生成两颗，将骰子改为冲向同区域的连翘，并选择：停下/往同方向再冲等量距离'],
     ['雄鹰','与地主拼钱若胜，掠夺其1张卡'],
    ['杨柳','异区域生成两枝，令间隔1区域的他人重放前/本/后格为落点，你闭眼若猜对，令其往杨柳3次掷1'],
    ['精卫','他人结束令+1/2，其现金若为10的倍数，你+5'],
    ['亡灵','现金、地产始终为0直到场上只剩1个他人，亡灵不能成为他人目标'],
  ];
  data.forEach((d, i) => { petInfoMap[(i+1)+'.png'] = { name: d[0], desc: d[1] }; });
})();

function getPetInfo(petImage) {
  if (!petImage) return null;
  return petInfoMap[petImage] || null;
}
function isPassivePet(petImage) {
  const info = getPetInfo(petImage);
  if (!info) return false;
  return info.name === '福星高照猪' || info.name === '恶狼' || info.name === '锦鲤' || info.name === '穷奇' || info.name === '青龙' || info.name === '吸血蚊' || info.name === '变色龙' || info.name === '和平熊猫' || info.name === '毒蛇' || info.name === '白虎' || (info.desc && info.desc.includes('被动'));
}
function hasKoiPet(player) {
  return player && player.petImage === '8.png' && !player.petFlipped;
}

const jiyuList = [
  { id: 1, name: '旅游', desc: '到内蒙', weight: 1 },
  { id: 2, name: '喜新厌旧', desc: '扔掉旧宠物，然后抽新宠物', weight: 1 },
  { id: 3, name: '安眠药', desc: '令他人休息1回合', weight: 1 },
  { id: 4, name: '扒房牵牛', desc: '给他人16并令其随机一块地的房屋归零', weight: 1 },
  { id: 5, name: '栽赃', desc: '可-7令他人到监狱', weight: 1 },
  { id: 6, name: '你来我往', desc: '指定两人随机互换一块地', weight: 1 },
  { id: 7, name: '赶尽杀绝', desc: '令他人-14', weight: 1 },
  { id: 8, name: '联姻', desc: '可将一块地给他人，令其给你40', weight: 1 },
  { id: 9, name: '因祸得福', desc: '失去某地产，+地价+房屋+10的现金', weight: 1 },
  { id: 10, name: '躺赢', desc: '可休息1回合并+随机骰子数*2的钱', weight: 1 },
  { id: 11, name: '传销', desc: '所有人拼钱，第一名获取每人5', weight: 1 },
  { id: 12, name: '搏命', desc: '可给他人9，然后将其所有钱冻结直到你回合开始', weight: 1 },
  { id: 13, name: '劫富济贫', desc: '可令他人现金最多的给最少的8，然后你+5', weight: 1 },
  { id: 14, name: '风水轮流转', desc: '所有人按顺序换位置', weight: 1 },
  { id: 15, name: '租金', desc: '每有1块地+4', weight: 1 },
  { id: 16, name: '现金流水', desc: '现金补充到40', weight: 1 },
  { id: 17, name: '走私贩子', desc: '抽取并拍卖一只宠物', weight: 1 },
  { id: 18, name: '禁足', desc: '令他人下回合停留原地', weight: 1 },
  { id: 19, name: '乐善好施', desc: '你+10，若为全场最多，交给最少的9', weight: 1 },
  { id: 20, name: '流放', desc: '可花11令他人进海南', weight: 1 },
  { id: 21, name: '结伴玩乐', desc: '令1人和你到上海', weight: 1 },
  { id: 22, name: '拖累', desc: '下回合只能掷1-2，令他人也一样', weight: 1 },
  { id: 23, name: '服务费', desc: '可令他人再动一次，然后给你5', weight: 1 },
  { id: 24, name: '闻鸡起舞', desc: '下回合掷出骰子数+1', weight: 1 },
  { id: 25, name: '贪污', desc: '可+20并到监狱', weight: 1 },
  { id: 26, name: '被陨石砸中', desc: '冻结25/-10', weight: 1 },
  { id: 27, name: '直播睡觉', desc: '休息1回合，令每人给你3', weight: 1 },
  { id: 28, name: '宴会', desc: '从你开始按顺序轮转，每人+5，直到第（你地产的数量）人结束', weight: 1 },
  { id: 29, name: '爱屋及乌', desc: '可令地产-1，宠物+1', weight: 1 },
  { id: 30, name: '土地兼并', desc: '可与他人暗置一张地产拼地价，大的获得两张卡，然后给小的（两地产地价和）的补偿', weight: 1 },
  { id: 31, name: '笑里藏刀', desc: '可给他人1地产，然后令其给你地价+15的钱', weight: 1 },
  { id: 32, name: '下毒', desc: '可花37令他人宠物-1', weight: 1 },
  { id: 33, name: '抓住小偷', desc: '+10', weight: 1 },
  { id: 34, name: '遇见小偷', desc: '-8', weight: 1 },
  { id: 35, name: '笨鸟先飞', desc: '再动一次', weight: 1 },
  { id: 36, name: '考研报名', desc: '-6', weight: 1 },
  { id: 37, name: '街头斗殴', desc: '选一人同到监狱', weight: 1 },
  { id: 38, name: '网红打卡', desc: '到重庆', weight: 1 },
  { id: 39, name: '搬砖达人', desc: '可$15盖房升级', weight: 1 },
  { id: 40, name: '街头卖艺', desc: '每人给你6', weight: 1 },
  { id: 41, name: '被狗咬', desc: '药费付10', weight: 1 },
  { id: 42, name: '工作过度', desc: '休息1回合', weight: 1 },
  { id: 43, name: '圣母', desc: '交给地产数最少的人10', weight: 1 },
  { id: 44, name: '踏破铁鞋', desc: '可花20获得一块价格＜36的空地', weight: 1 },
  { id: 45, name: '厌学', desc: '到医院/-8', weight: 1 },
  { id: 46, name: '考试满分', desc: '+5', weight: 1 },
  { id: 47, name: '巧手', desc: '获得多功能卡', weight: 1 },
  { id: 48, name: '大意', desc: '随机失去一张卡', weight: 1 },
  { id: 49, name: '炸弹狂人', desc: '获得炸弹卡', weight: 1 },
  { id: 50, name: '基建', desc: '获得建房卡', weight: 1 },
  { id: 51, name: '德克萨斯州', desc: '获得龙卷风卡', weight: 1 },
  { id: 52, name: '命运', desc: '获得1个骰子', weight: 1 },
  { id: 53, name: '闪现', desc: '获得闪现卡', weight: 1 },
  { id: 54, name: '拆迁', desc: '获得强拆卡', weight: 1 },
  { id: 55, name: '开发', desc: '获得征地卡', weight: 1 },
  { id: 56, name: '歹徒', desc: '获得抢劫卡', weight: 1 },
  { id: 57, name: '守护', desc: '获得保护卡', weight: 1 },
  { id: 58, name: '缅北旅游', desc: '冻结17', weight: 1 },
  { id: 59, name: '奋斗', desc: '工资+2', weight: 1 },
  { id: 60, name: '迟到', desc: '工资-2', weight: 1 },
  { id: 61, name: '铁门', desc: '[需钥匙]随机获得4张卡', weight: 1 },
  { id: 62, name: '银门', desc: '[需钥匙]工资+30，你的所有地产过路费+3', weight: 1 },
  { id: 63, name: '翻山', desc: '到云贵', weight: 1 },
  { id: 64, name: '国内旅游', desc: '到港/澳/台', weight: 1 },
  { id: 65, name: '夺宝', desc: '立刻获得钻石', weight: 1 },
  { id: 66, name: '砸锅卖铁', desc: '拍卖你的一块地产', weight: 1 },
  { id: 67, name: '霉运', desc: '随机-3*骰子数的钱', weight: 1 },
  { id: 68, name: '刮痧', desc: '令现金＞50的他人-7', weight: 1 },
  { id: 69, name: '交易', desc: '可与他人各指定一块地互换', weight: 1 },
  { id: 70, name: '择木而栖', desc: '可拼钱，赢获得输家的宠物', weight: 1 },
  { id: 71, name: '自爆卡车', desc: '可-1地卡，令他人也各-1', weight: 1 },
  { id: 72, name: '机会', desc: '选择获得7/随机骰子数*2', weight: 1 },
  { id: 73, name: '神兵天降', desc: '可位移6格内他人处', weight: 1 },
  { id: 74, name: '搬家', desc: '将你某房屋迁移到另一地产', weight: 1 },
  { id: 75, name: '阶层滑落', desc: '你随机一座房屋降级', weight: 1 },
  { id: 76, name: '混水摸鱼', desc: '有1/3概率抽中获得他人卡片', weight: 1 },
  { id: 77, name: '恶人先告状', desc: '掠夺他人4并令其进监狱', weight: 1 },
  { id: 78, name: '强买', desc: '可地价+10收购他人空地', weight: 1 },
  { id: 79, name: '调虎离山', desc: '可拼钱并获得对方的钱，输到海南', weight: 1 },
  { id: 80, name: '抛砖引玉', desc: '你指定目标拿出一块地互换', weight: 1 },
  { id: 81, name: '远交近攻', desc: '可拼钱，你的钱交给第三人，输给赢10', weight: 1 },
  { id: 82, name: '瞬移', desc: '飞往他人位置', weight: 1 },
  { id: 83, name: '智力节目', desc: '可答题淘金', weight: 1 },
  { id: 84, name: '重金求宠', desc: '可$40在商店的2只宠物选1', weight: 1 },
  { id: 85, name: '万人迷', desc: '可把所有他人拉到你的格子', weight: 1 },
  { id: 86, name: '同步', desc: '可令所有他人和你本次点数一样', weight: 1 },
  { id: 87, name: '陷害', desc: '给7令他人进监狱', weight: 1 },
  { id: 88, name: '车祸', desc: '放置大运车，撞到人后令其进医院', weight: 1 },
  { id: 89, name: '难题', desc: '选择-7/-随机骰子数*2', weight: 1 },
  { id: 90, name: '水果机', desc: '可花18扔3骰子，按相同数量得钱', weight: 1 },
  { id: 91, name: '吸铁石', desc: '可将他人拉到你位置', weight: 1 },
  { id: 92, name: '赃款', desc: '令他人冻结18', weight: 1 },
  { id: 93, name: '小偷', desc: '给目标6获得他人1张卡', weight: 1 },
  { id: 94, name: '千变', desc: '可随机变化一张卡', weight: 1 },
  { id: 95, name: '大地主', desc: '获得全部地产直到下回合结束', weight: 1 },
  { id: 96, name: '残肢', desc: '你随机地产，令其路费-3/判1-2失去', weight: 1 },
  { id: 97, name: '寻仙', desc: '找到仙人，得到昆仑赐福', weight: 1 },
  { id: 98, name: '水月', desc: '临时金钱+15', weight: 1 },
  { id: 99, name: '雾里看花', desc: '临时金钱+20', weight: 1 },
  { id: 100, name: '拔罐', desc: '令移除随机一项状态', weight: 1 },
  { id: 101, name: '湖南赶尸', desc: '令后退3步', weight: 1 },
  { id: 102, name: '查封', desc: '令某地停业', weight: 1 },
  { id: 103, name: '造谣', desc: '令某地路费-1', weight: 1 },
  { id: 104, name: '繁荣', desc: '令某地路费+1', weight: 1 },
  { id: 105, name: '美人计', desc: '指定两人竞价给你钱，价低者随机房屋降级，没有房屋则-10', weight: 1 },
  { id: 106, name: '蛊惑', desc: '你指定他人下回合骰子点数', weight: 1 },
  { id: 107, name: '收买', desc: '可给每人3，然后你指定自己下回合点数', weight: 1 },
  { id: 108, name: '暗度陈仓', desc: '可给他人7并猜他选的地，猜对获得', weight: 1 },
  { id: 109, name: '乾坤大挪移', desc: '可与他人换位置', weight: 1 },
  { id: 110, name: '劳模', desc: '获得免休卡', weight: 1 },
  { id: 111, name: '龟速', desc: '获得乌龟卡', weight: 1 },
  { id: 112, name: '倒带', desc: '获得倒退卡', weight: 1 },
  { id: 113, name: '国庆节', desc: '获得免路费卡', weight: 1 },
  { id: 114, name: '联合', desc: '选一人各+5', weight: 1 },
  { id: 115, name: '打草惊蛇', desc: '暗指某地产，每个人可以给你7，然后若地主没给，令其路费-3', weight: 1 },
  { id: 116, name: '孩子套狼', desc: '所有人同时选择:-10/+4，≤一半人选前者则+20', weight: 1 },
  { id: 117, name: '离间', desc: '先后指定两人，轮流-1，若不如此做的-10', weight: 1 },
  { id: 118, name: '无中生有', desc: '可$20扔掉1地产，随机抽取银行两张空地，获取其中所有＜此地价的地产', weight: 1 },
  { id: 119, name: '攻城', desc: '令他人展示任意钱，可弃置等量钱选其房屋降级，否则弃置其一半展示的钱', weight: 1 },
  { id: 120, name: '暴政', desc: '向每个人征收2，他人决定是否反抗，若有反抗你的征收失败，随机1个反抗-14，其他反抗抢你2；若没有反抗则重复新一轮暴政', weight: 1 },
  { id: 121, name: '倒影', desc: '-7/到监狱/工资-3三选一，令他人与你做同样的事', weight: 1 },
  { id: 122, name: '地产税', desc: '每有1块地-3', weight: 1 },
  { id: 123, name: '存钱', desc: '可-40，若如此做，10轮后+50', weight: 1 },
  { id: 124, name: '德州', desc: '与随机对手德州扑克，三局两胜，输给赢家10', weight: 1 },
  { id: 125, name: '轮次', desc: '拿出6张扑克选择一个目标，你们同时选点数，你先获得，第二轮点数小的先获得。总点数小的给对方13', weight: 1 },
  { id: 126, name: '先知', desc: '观看3张机遇卡，然后将其任意顺序放在顶部', weight: 1 },
  { id: 127, name: '推算', desc: '20个只展示5个数，你和随机一人猜最大的点数，错误给点数接近的13', weight: 1 },
  { id: 128, name: '双面间谍', desc: '可给两人不同数量的钱，少的选收下：给你双倍的钱；多的选退回：随机地产-1（没地产-30）', weight: 1 },
  { id: 129, name: '卡波', desc: '与随机对手卡波！尽可能让自己的牌点数小，输给赢家12', weight: 1 },
  { id: 130, name: '镜花', desc: '临时金钱+10', weight: 1 },
  { id: 131, name: '反转', desc: '你选择-10/+10，其他人选择-5/反转，若有反转，你承受反转结果，选择反转的人承受你选的结果', weight: 1 },
  { id: 132, name: '心理学', desc: '准备3-6-9的钱，你给猜对的每人等量的钱，猜错的每人给你等量的钱', weight: 1 },
  { id: 133, name: '连环计', desc: '暗置（3-6）并让下家猜，猜对获得，猜错给你等额钱并令下家也执行此机遇', weight: 1 },
  { id: 134, name: '议案', desc: '拿出X钱，随机两他人选择成功/失败，若都成功，你获得随机骰子且+8；一人成功你给他X钱', weight: 1 },
  { id: 135, name: '封控', desc: '指定某人，你和其他人选点数，其下回合不能掷出这些点', weight: 1 },
  { id: 136, name: '瞒天过海', desc: '选择一个点数，猜对的+9。无人猜对，你下回合为此点且+9', weight: 1 },
  { id: 137, name: '合作任务', desc: '选他人凑钱给银行，若≥随机X（10-20），各+X+3', weight: 1 },
  { id: 138, name: '迷惑', desc: '选个点数X和随机2个点数交给他人，若其猜对，其余点数选1作为下回点数；若猜错，X作为他下回合点数且给你13', weight: 1 },
  { id: 139, name: '打猎', desc: '老虎4，黑牛0.5，虫子0.2，人-14，向下取整', weight: 1 },
  { id: 140, name: '金花', desc: '每人默认底注5并摸2牌，之后每押1点数-1，最大的与银行拼点，输：他人+押注的钱，赢平得全部', weight: 1 },
  { id: 141, name: '精算', desc: '翻出9张牌，18秒内分成点数相等的两组，＜4张-13，4张+0，5-6张+5，7张+10，8张+20，9张+50', weight: 1 },
  { id: 142, name: '受难', desc: '获得灾厄3回合', weight: 1 },
];

// 灾厄效果列表
const zaieList = [
  // weight:2
  { id: 1, desc: '-4', weight: 2, effect: (p) => { previewMoney(p.id, -4); return '-4'; } },
  { id: 2, desc: '-3', weight: 2, effect: (p) => { previewMoney(p.id, -3); return '-3'; } },
  { id: 3, desc: '-2', weight: 2, effect: (p) => { previewMoney(p.id, -2); return '-2'; } },
  { id: 4, desc: '-1', weight: 2, effect: (p) => { previewMoney(p.id, -1); return '-1'; } },
  { id: 5, desc: '工资-1', weight: 2, effect: (p) => { p.salary = Math.max(0, (p.salary || 0) - 1); return '工资-1'; } },
  { id: 6, desc: '你给每人2', weight: 2, effect: (p) => { players.forEach(op => { if (op.id !== p.id && !op.bankrupt) { previewMoney(p.id, -2); previewMoney(op.id, 2); } }); return '给每人2'; } },
  { id: 7, desc: '冻结5', weight: 2, effect: (p) => { previewMoney(p.id, -5); p.frozen = (p.frozen || 0) + 5; return '冻结5'; } },
  { id: 8, desc: '休息1回合', weight: 2, effect: (p) => { return 'rest'; } },
  { id: 9, desc: '后退1步', weight: 2, effect: (p) => { p.position = (p.position - 1 + board.length) % board.length; return '后退1步'; } },
  // weight:1
  { id: 10, desc: '你给每人3', weight: 1, effect: (p) => { players.forEach(op => { if (op.id !== p.id && !op.bankrupt) { previewMoney(p.id, -3); previewMoney(op.id, 3); } }); return '给每人3'; } },
  { id: 11, desc: '-6', weight: 1, effect: (p) => { previewMoney(p.id, -6); return '-6'; } },
  { id: 12, desc: '-5', weight: 1, effect: (p) => { previewMoney(p.id, -5); return '-5'; } },
  { id: 13, desc: '工资-2', weight: 1, effect: (p) => { p.salary = Math.max(0, (p.salary || 0) - 2); return '工资-2'; } },
  { id: 14, desc: '后退3步', weight: 1, effect: (p) => { p.position = (p.position - 3 + board.length) % board.length; return '后退3步'; } },
  { id: 15, desc: '冻结10', weight: 1, effect: (p) => { previewMoney(p.id, -10); p.frozen = (p.frozen || 0) + 10; return '冻结10'; } },
  { id: 16, desc: '灾厄延长3回合', weight: 1, effect: (p) => { p.zaie = (p.zaie || 0) + 3; return '灾厄延长3回合'; } },
  { id: 17, desc: '不能买地建房3回合', weight: 1, effect: (p) => { p.fengdiTurns = (p.fengdiTurns || 0) + 3; return '不能买地建房3回合'; } },
];

// 所有三思选项（共63项，对照sansi.txt）
const allSansiOptions = [
  '-10，工资+3', '+10，工资-3', '骰子+1，工资-3', '到澳门，工资-2', '每人给你4，工资-4', '和下家一起+7，工资-3', '木门[需钥匙]：+18，工资+5', '工资-3，临时金钱+10', '随机地产停业，工资+2', '-38，随机获得空地', '休息2回合，随机2个他人地产停业', '-10，获得随机1张卡片', '-7', '上家-4，下家-3', '到起点'
];

function weightedRandomZaie() {
  const totalWeight = zaieList.reduce((sum, z) => sum + z.weight, 0);
  let r = Math.random() * totalWeight;
  for (const z of zaieList) {
    r -= z.weight;
    if (r <= 0) return z;
  }
  return zaieList[0];
}

// 统一状态管理：获取玩家所有状态列表
function getPlayerStatuses(p) {
  const statuses = [];
  if (p.restTurns > 0) statuses.push({ name: '休息', clear: () => { p.restTurns = 0; } });
  if (p.sheltered) statuses.push({ name: '避难', clear: () => { p.sheltered = false; p.shelteredTurns = 0; } });
  if (p.shihua) statuses.push({ name: '石化', clear: () => { p.shihua = false; p.shihuaDice = 0; } });
  if (p.guhuoDice) statuses.push({ name: '蛊惑', clear: () => { p.guhuoDice = 0; p.guhuoBy = null; } });
  if (p.shoumaiDice) statuses.push({ name: '收买', clear: () => { p.shoumaiDice = 0; } });
  if (p.yinyueDice) statuses.push({ name: '音乐', clear: () => { p.yinyueDice = 0; p.yinyueBy = null; } });
  if (p.bingdong > 0) statuses.push({ name: '冰冻', clear: () => { p.bingdong = 0; } });
  if (p.jinzu) statuses.push({ name: '禁足', clear: () => { p.jinzu = false; } });
  if (p.protectedAsset) statuses.push({ name: '保护', clear: () => { p.protectedAsset = null; p.protectedAssetName = null; } });
  if (p.daotui) statuses.push({ name: '倒退', clear: () => { p.daotui = false; } });
  if (p.zaie && p.zaie > 0) statuses.push({ name: '灾厄', clear: () => { p.zaie = 0; } });
  if (p.bomingFrozen) statuses.push({ name: '搏命', clear: () => { p.bomingFrozen = null; } });
  if (p.tuolei && p.tuolei.turns > 0) statuses.push({ name: '拖累', clear: () => { p.tuolei = null; } });
  if (p.wenjigifwu) statuses.push({ name: '闻鸡起舞', clear: () => { p.wenjigifwu = false; } });
  if (p.fengdiTurns > 0) statuses.push({ name: '封地', clear: () => { p.fengdiTurns = 0; } });
  if (p.dizhuTurns > 0) statuses.push({ name: '地主', clear: () => { p.dizhuTurns = 0; } });
  if (p.fengkongDice && p.fengkongDice.length > 0) statuses.push({ name: '封控', clear: () => { p.fengkongDice = []; } });
  if (p.syncedDice) statuses.push({ name: '同步', clear: () => { p.syncedDice = 0; p.syncedByName = null; } });
  if (p.diceEffects && p.diceEffects.length > 0) statuses.push({ name: '骰子效果', clear: () => { p.diceEffects = []; } });
  if (p.inJail) statuses.push({ name: '监狱', clear: () => { p.position = 1; p.inJail = false; p.jailState = null; } });
  if (p.hezongState === 'forced' || p.hezongState === 'normal') statuses.push({ name: '合纵', clear: () => { p.hezongState = null; } });
  if (p.mammothFrozenBy) statuses.push({ name: '猛犸冰封', clear: () => { delete p.mammothFrozenBy; } });
  if (p.mammothSelfFrozen) statuses.push({ name: '猛犸自封', clear: () => { delete p.mammothSelfFrozen; } });
  if (p.wolfMark) statuses.push({ name: '狼标记', clear: () => { delete p.wolfMark; } });
  if (p.cards) {
    const hiddenIdx = p.cards.findIndex(c => c.hiddenType);
    if (hiddenIdx !== -1) statuses.push({ name: '隐藏卡', clear: () => { p.cards.splice(hiddenIdx, 1); } });
  }
  return statuses;
}

function playerHasStatus(p) {
  return getPlayerStatuses(p).length > 0;
}

function randomClearStatus(p) {
  const statuses = getPlayerStatuses(p);
  if (statuses.length === 0) return null;
  const removed = statuses[Math.floor(Math.random() * statuses.length)];
  removed.clear();
  return removed.name;
}

// 统一状态管理：设置状态（进入M3）
function setPlayerState(player, stateName, value, triggerPassive = true) {
  const prevValue = player[stateName];
  const wasActive = prevValue !== undefined && prevValue !== null && prevValue !== false && prevValue !== 0;
  const nowActive = value !== undefined && value !== null && value !== false && value !== 0;
  
  if (value === null || value === undefined || value === false) {
    delete player[stateName];
  } else {
    player[stateName] = value;
  }
  
  // 状态进入M3时检测被动宠物
  // inJail: 只在首次进入时判定（岛→医院/监狱等类型变更不重复判定）
  // 其他状态（restTurns/frozen等）：每次添加都独立判定
  if (triggerPassive && nowActive) {
    if (stateName === 'inJail') {
      if (!wasActive) checkPassivePetSkill(player, stateName);
    } else {
      checkPassivePetSkill(player, stateName);
    }
  }
}

// 统一状态管理：清除状态（移出M3）
function clearPlayerState(player, stateName) {
  delete player[stateName];
}

// 检测被动宠物技能
function checkPassivePetSkill(player, stateName) {
  if (!player.petImage || player.petFlipped) return;
  const petInfo = getPetInfo(player.petImage);
  if (!petInfo) return;
  if (petInfo.name === '福星高照猪') {
    handleFuxingPetSkill(player, stateName);
  }
}

// 福星高照猪被动技能：状态进入M3时自动判定
function handleFuxingPetSkill(player, stateName) {
  const roll = Math.floor(Math.random() * 6) + 1;
  if (roll <= 3) {
    io.emit('showTip', { imgSrc: '/drawable/chongwu/1.png', text: '福气......下回合到' });
    return;
  }
  delete player[stateName];
  delete player.shelteredTurns;
  player.sheltered = false;
  delete player.restTurns;
  delete player.jailState;
  delete player.jailTurns;
  delete player.jailDice;
  if (roll === 4) {
    player.restTurns = 1;
    io.emit('showTip', { imgSrc: '/drawable/chongwu/1.png', text: '福星高照！休息1回合' });
  } else if (roll === 5) {
    io.emit('showTip', { imgSrc: '/drawable/chongwu/1.png', text: '福星高照！对你无效' });
  } else if (roll === 6) {
    player.petFlipped = !player.petFlipped;
    const randomCard = getRandomCard();
    addCardToPlayer(player, randomCard);
    io.emit('showTip', { imgSrc: '/drawable/chongwu/1.png', text: `福星高照！宠物翻面并获得${randomCard.name}` });
  }
}

const qiyuList = [
  { id: 1, name: '假奇遇', desc: '什么事都没发生', weight: 1 },
  { id: 2, name: '空中楼阁', desc: '你随机某地修建空中楼阁，路费+15', weight: 1 },
  { id: 3, name: '中彩票', desc: '+80', weight: 1 },
  { id: 4, name: '极地求生', desc: '从当前玩家开始选择开枪/反弹（无人打你你会死）/空枪', weight: 2},
  { id: 5, name: '闯关', desc: '初始奖金6，成功率9/10', weight: 2 },
  { id: 6, name: '改朝换代', desc: '与他人互换全部地产卡', weight: 1 },
  { id: 7, name: '拜金主义', desc: '与他人互换金钱', weight: 1 },
  { id: 8, name: '任我行', desc: '飞向任意地，然后获得3张传送卡', weight: 1 },
  { id: 9, name: '农民起义', desc: '选三块地，与他人随机3块地互换（不足3视为3）', weight: 1 },
  { id: 10, name: '噩耗', desc: '-40', weight: 1 },
  { id: 11, name: '世界大战', desc: '回合结束每人-10直到游戏结束', weight: 1 },
  { id: 12, name: '挖到宝藏', desc: '+66', weight: 1 },
  { id: 13, name: '印假钞', desc: '+100', weight: 1 },
  { id: 14, name: '升官', desc: '工资+30', weight: 1 },
  { id: 15, name: '自爆', desc: '现金减半，令他人也减半', weight: 1 },
  { id: 16, name: '携手', desc: '现金+50%，令他人也+50%', weight: 1 },
  { id: 17, name: '纪检委', desc: '冻结他人80', weight: 1 },
  { id: 18, name: '僵尸封城', desc: '随机地产-2', weight: 1 },
  { id: 19, name: '归还', desc: '所有他人失去宠物，你免费获得1随机宠物', weight: 1 },
  { id: 20, name: '资本主义罪', desc: '进监狱', weight: 1 },
  { id: 21, name: '同归于尽', desc: '-40，每个他人-60', weight: 1 },
  { id: 22, name: '荒漠化', desc: '所有他人的房屋降级', weight: 1 },
  { id: 23, name: '高考', desc: '群体竞价拼钱，按名次依次获得50-20-0-负10-负20-负50', weight: 2 },
  { id: 24, name: '野心家', desc: '选择+10或争夺60（仅1人选时生效）', weight: 2 },
  { id: 25, name: '大慈善家', desc: '可将你所有现金交给他人，然后+50', weight: 1 },
  { id: 26, name: '共产主义', desc: '将你一半的现金给所有他人平分', weight: 1 },
  { id: 27, name: '酒吧', desc: '去酒吧人数≤一半各+35，在家的+5', weight: 2 },
  { id: 28, name: '大跃进', desc: '你的全部房屋升级', weight: 1 },
  { id: 29, name: '音乐指挥', desc: '指定每人点数', weight: 2 },
  { id: 30, name: '共同富裕', desc: '其他人可失去最低价地产，然后若和你地产数相同各+20；否则-30', weight: 1 },
  { id: 31, name: '石化', desc: '不能移动直到判5-6', weight: 1 },
  { id: 32, name: '移花接木', desc: '将他人1栋房屋转移给自己', weight: 1 },
  { id: 33, name: '核爆炸', desc: '令某排房屋全部变为空地', weight: 1 },
  { id: 34, name: '恐怖份子', desc: '令所有他人失去地价最高的一块地', weight: 1 },
  { id: 35, name: '焕然一新', desc: '可令某排房屋全升级', weight: 1 },
  { id: 36, name: '横行霸道', desc: '强占某人随机2块地产', weight: 1 },
  { id: 37, name: '白色恐怖', desc: '令所有他人进监狱', weight: 1 },
  { id: 38, name: '年假', desc: '令所有他人到海南', weight: 1 },
  { id: 39, name: '孤家寡人', desc: '失去全部卡和宠物', weight: 1 },
  { id: 40, name: '金门', desc: '[需钥匙]获得6张卡，+100，工资+40', weight: 1 },
  { id: 41, name: '声东击西', desc: '声明他人地产卡A并进攻B，此人保护1张地卡', weight: 2 },
  { id: 42, name: '赛道', desc: '每人选择点数1-5，有相同的变0并-20，唯一最大的得50', weight: 2 },
  { id: 43, name: '离婚', desc: '可将所有地产卡交给他人，其分成两份，你获得1份', weight: 2 },
  { id: 44, name: '囚徒', desc: '选两个人当囚徒，各自选择合作/背叛，打开，若都是合作各-5；都是背叛各-40；否则背叛的+30，合作的-50', weight: 2 },
  { id: 45, name: '卡奴', desc: '自选获得4张卡', weight: 1 },
  { id: 46, name: '流感', desc: '所有他人的地产停业', weight: 1 },
  { id: 47, name: '吸毒', desc: '临时金钱+300', weight: 1 },
  { id: 48, name: '缠身', desc: '获得灾厄10回合', weight: 1 },
  { id: 49, name: '卡皇', desc: '获得全套卡片', weight: 1 },
];//奇遇

const board = [
  { id: 0, name: '起点', type: 'start', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 1, name: '财产罪', type: 'jail', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0, jailType: '财产罪' },
  { id: 2, name: '四合院', type: 'siheyuan', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 3, name: '宁夏', type: 'property', price: 28, rent: 4, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 4, name: '内蒙', type: 'property', price: 30, rent: 4, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 5, name: '江西', type: 'property', price: 24, rent: 3, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 6, name: '昆仑', type: 'kunlun', price: 200, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 7, name: '机遇', type: 'chance', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 8, name: '台湾', type: 'property', price: 36, rent: 5, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 9, name: '香港', type: 'property', price: 35, rent: 5, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 10, name: '澳门', type: 'property', price: 31, rent: 4, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 11, name: '机场', type: 'property', price: 40, rent: 5, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 12, name: '三思', type: 'sans', price: 220, rent: 44, owner: null, isProperty: false, houseLevel: 0 },
  { id: 13, name: '宠物店', type: 'pet', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 14, name: '机遇', type: 'chance', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 15, name: '四川', type: 'property', price: 34, rent: 5, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 16, name: '重庆', type: 'property', price: 37, rent: 5, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 17, name: '云贵', type: 'property', price: 29, rent: 4, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 18, name: '拼钱', type: 'pinqian', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 19, name: '长江', type: 'changjiang', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 20, name: '合纵', type: 'hezong', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 21, name: '广东', type: 'property', price: 39, rent: 5, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 22, name: '北京', type: 'property', price: 42, rent: 5, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 23, name: '上海', type: 'property', price: 41, rent: 5, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 24, name: '钻石', type: 'diamond', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 25, name: '机遇', type: 'chance', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 26, name: '五岳', type: 'property', price: 38, rent: 5, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 27, name: '新疆', type: 'property', price: 25, rent: 4, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 28, name: '西藏', type: 'property', price: 27, rent: 4, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 29, name: '青海', type: 'property', price: 26, rent: 4, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 30, name: '改土', type: 'gaitu', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 31, name: '拍卖卡', type: 'auction', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 32, name: '机遇', type: 'chance', price: 0, rent: 0, owner: null, isProperty: false, houseLevel: 0 },
  { id: 33, name: '广西', type: 'property', price: 23, rent: 3, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 34, name: '江苏', type: 'property', price: 33, rent: 4, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
  { id: 35, name: '浙江', type: 'property', price: 32, rent: 4, owner: null, isProperty: true, houseLevel: 0, rentBonus: 0 },
];

const propertyData = [
  ["广西", [23, 1, 3, 6, 15, 31]],
  ["江西", [24, 1, 3, 6, 16, 32]],
  ["新疆", [25, 2, 4, 6, 17, 33]],
  ["青海", [26, 2, 4, 7, 17, 35]],
  ["西藏", [27, 2, 4, 7, 18, 36]],
  ["宁夏", [28, 2, 4, 7, 19, 37]],
  ["云贵", [29, 2, 4, 7, 19, 39]],
  ["内蒙", [30, 2, 4, 8, 20, 40]],
  ["澳门", [31, 2, 4, 8, 21, 41]],
  ["浙江", [32, 2, 5, 8, 21, 43]],
  ["江苏", [33, 2, 5, 8, 22, 44]],
  ["四川", [34, 2, 5, 9, 23, 45]],
  ["香港", [35, 3, 5, 9, 23, 47]],
  ["台湾", [36, 3, 5, 9, 24, 48]],
  ["重庆", [37, 3, 5, 9, 25, 49]],
  ["五岳", [38, 3, 5, 10, 25, 51]],
  ["泰山", [38, 3, 5, 10, 25, 51]],
  ["华山", [38, 3, 5, 10, 25, 51]],
  ["衡山", [38, 3, 5, 10, 25, 51]],
  ["恒山", [38, 3, 5, 10, 25, 51]],
  ["嵩山", [38, 3, 5, 10, 25, 51]],
  ["广东", [39, 3, 6, 10, 26, 52]],
  ["机场", [40, 3, 6, 10, 27, 53]],
  ["上海", [41, 3, 6, 10, 27, 55]],
  ["北京", [42, 3, 6, 11, 28, 56]]
];

let macauState = null;
let airportState = null;
let diceAnimState = null;
let meihouwangState = null; // 美猴王状态：{ playerId, position, remainingTurns, pendingChoice }
let islandSwapBids = {};

function getRent(space) {
  if (!space.isProperty) return space.rent || 0;
  const info = propertyData.find(p => p[0] === space.name);
  if (!info) return space.rent || 0;
  const level = space.houseLevel || 0;
  // propertyData数组格式：[price, rent0, rent1, rent2, rent3, rent4]
  // 索引0是价格，索引1-5是0-4房的路费
  const rentIndex = Math.min(level + 1, info[1].length - 1);
  const baseRent = info[1][rentIndex];
  const bonus = space.rentBonus || 0;
  const finalRent = Math.max(0, baseRent + bonus);
  return finalRent;
}

const PROPERTY_ROW_MAP = {
  1: [3, 4, 5],
  2: [8, 9, 10],
  3: [13, 15, 16, 17],
  4: [21, 22, 23],
  5: [27, 28, 29],
  6: [31, 33, 34, 35]
};
function getRowIdsForSpace(spaceId) {
  const gridRow = Math.floor(spaceId / 6) + 1;
  return PROPERTY_ROW_MAP[gridRow] || [];
}

const characters = ['hong', 'cheng', 'huang', 'lv', 'lan', 'zi'];
const charColors = { hong: '#e74c3c', cheng: '#e67e22', huang: '#f1c40f', lv: '#2ecc71', lan: '#3498db', zi: '#9b59b6' };
const mzContent = require('fs').readFileSync('mingzi.txt', 'utf-8').split('\n');
const mzSurnames = mzContent[0] ? mzContent[0].split('，').map(s => s.trim()).filter(s => s) : [];
const mzGivenNames = mzContent[1] ? mzContent[1].split('，').map(s => s.trim()).filter(s => s) : [];



function coloredName(name, color) {
  return name;
}

function triggerYaoshi(playerId, description, reward, onUsed) {
  const player = players.find(p => p.id === playerId);
  if (!player || !player.cards) return false;
  const idx = player.cards.findIndex(c => c.id === 13);
  if (idx === -1) return false;
  if (!onUsed) return true;
  // 直接使用钥匙，不再弹TCK询问
  player.cards.splice(idx, 1);
  io.emit('updateAreaE', { message: `${coloredName(player.name, player.color)}使用钥匙，${reward}` });
  io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
  onUsed();
  return true;
}

// 检查保护资产，返回true表示有保护且已触发（资产保留），false表示无保护
function checkProtectedAsset(playerId, assetType) {
  const player = players.find(p => p.id === playerId);
  if (!player) return false;
  
  if (player.protectedAsset === assetType) {
    // 保护卡使用时已移除，只需清除保护状态
    const protectedName = player.protectedAssetName || (assetType === 'pet' ? '宠物' : '地产');
    player.protectedAsset = null;
    player.protectedAssetName = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(player.name, player.color)}的保护卡生效，${protectedName}免于失去` });
    return true;
  }
  return false;
}

function checkDuogongnengRent(playerId, rent, onUsed) {
  if (rent < 10) return false;
  const player = players.find(p => p.id === playerId);
  if (!player || !player.cards) return false;
  const idx = player.cards.findIndex(c => c.name === '多功能卡');
  if (idx === -1) return false;
  if (!onUsed) return true;
  pendingCardConfirm = { playerId, cardName: '多功能卡', hiddenType: 'duogongneng_rent', rent, onUsed };
  const playerSocket = io.sockets.sockets.get(playerId);
  if (playerSocket) {
    playerSocket.emit('cardConfirmPopup', { cardName: '多功能卡', image: 'duogongneng', description: `多功能卡：即将支付路费${rent}，是否使用令路费-10?`, reason: '路费减少' });
  }
  return true;
}

function checkKoiOrDuogongnengJudge(playerId, onUsed, originalResult) {
  const player = players.find(p => p.id === playerId);
  if (!player) return false;
  const hasDuo = player.cards && player.cards.some(c => c.name === '多功能卡');
  const hasKoi = hasKoiPet(player);
  if (!hasDuo && !hasKoi) return false;
  if (!onUsed) return true;
  const cardsInfo = [];
  if (hasKoi) cardsInfo.push({ text: '锦鲤', hiddenType: 'koi_judge' });
  if (hasDuo) cardsInfo.push({ text: '多功能卡', hiddenType: 'duogongneng_judge' });
  pendingCardConfirm = {
    playerId,
    cardsInfo,
    onUsedKoi: () => {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(player.name, player.color)}使用锦鲤重新判定` });
      if (onUsed) onUsed();
    },
    onUsedDuogongneng: () => {
      const idx = player.cards.findIndex(c => c.name === '多功能卡');
      if (idx !== -1) player.cards.splice(idx, 1);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(player.name, player.color)}使用多功能卡重新判定` });
      if (onUsed) onUsed();
    },
    onSkip: originalResult
  };
  const playerSocket = io.sockets.sockets.get(playerId);
  if (playerSocket) {
    playerSocket.emit('koiDuogongnengConfirm', { cards: cardsInfo });
  }
  const overlayImgs = [];
  if (hasKoi) overlayImgs.push('/drawable/chongwu/8.png');
  if (hasDuo) overlayImgs.push('/drawable/kapian/duogongneng.png');
  io.emit('koiDuogongnengOverlay', { imgs: overlayImgs, targetPlayerId: playerId, targetName: player.name, targetColor: player.color });
  return true;
}

function checkDuogongnengChance(playerId, onUsed, originalResult) {
  const player = players.find(p => p.id === playerId);
  if (!player || !player.cards) return false;
  const idx = player.cards.findIndex(c => c.name === '多功能卡');
  if (idx === -1) return false;
  if (!onUsed) return true;
  pendingCardConfirm = { playerId, cardName: '多功能卡', hiddenType: 'duogongneng_chance', onUsed, originalResult };
  const playerSocket = io.sockets.sockets.get(playerId);
  if (playerSocket) {
        playerSocket.emit('cardConfirmPopup', { cardName: '多功能卡', image: 'duogongneng', description: `是否重新抽机遇？`, reason: '重新抽机遇' });
  }
  return true;
}

let pendingCardConfirm = null;
let pendingHiddenResult = null;

function checkHiddenCardTarget(targetId, sourceId, callback) {
  // 自己选自己为目标时不触发隐藏卡
  if (targetId === sourceId) {
    callback(false);
    return;
  }
  const target = players.find(p => p.id === targetId);
  if (!target || !target.cards) {
    callback(false);
    return;
  }

  const hiddenCards = target.cards.filter(c => c.hiddenType && ['quxiao', 'jianyuan', 'zhuanyi', 'fantan'].includes(c.hiddenType));
  if (hiddenCards.length === 0) {
    callback(false);
    return;
  }

  const source = players.find(p => p.id === sourceId);
  const hiddenTypeTexts = {
    quxiao: '是否使用隐藏卡，取消本次目标？',
    jianyuan: '是否使用隐藏卡令其-9?',
    zhuanyi: '是否使用隐藏卡令目标转移?',
    fantan: '是否使用隐藏卡令效果反弹？'
  };

  const cardsInfo = hiddenCards.map(hc => ({
    cardName: hc.name,
    hiddenType: hc.hiddenType,
    cardIndex: target.cards.indexOf(hc),
    text: hiddenTypeTexts[hc.hiddenType] || `是否使用${hc.name}?`
  }));

  pendingCardConfirm = {
    playerId: targetId,
    cardsInfo: cardsInfo,
    reason: 'targeted',
    sourceId: sourceId,
    sourceName: source?.name,
    sourceColor: source?.color,
    _targetCallback: true,
    _callback: callback
  };

  const targetSocket = io.sockets.sockets.get(targetId);
  if (targetSocket) {
    // 发送给目标玩家，显示H区选项
    targetSocket.emit('hiddenCardMultiConfirm', { cards: cardsInfo, sourceName: source?.name, sourceColor: source?.color, isTarget: true });
  }
  // 广播给所有玩家，显示bottomBar图片覆盖
  io.emit('hiddenCardOverlay', { targetPlayerId: targetId, cards: cardsInfo, targetName: target.name, targetColor: target.color });
  io.emit('updateAreaE', { message: `${coloredName(source?.name, source?.color)}选择了${coloredName(target.name, target.color)}作为目标，是否使用隐藏卡？` });
}

function checkMianxiu(playerId, reason, extra) {
  const player = players.find(p => p.id === playerId);
  if (!player || !player.cards) return false;

  // 在放逐区时不能触发免休卡
  if (player.inJail || player.position === 1) {
    return false;
  }

  const idx = player.cards.findIndex(c => c.name === '免休卡');
  if (idx === -1) return false;
  const current = players[currentPlayerIndex];
  pendingCardConfirm = { playerId, cardName: '免休卡', cardIndex: idx, reason, ...extra, currentTurnSocketId: current?.id };

  const playerSocket = io.sockets.sockets.get(playerId);
  if (playerSocket) {
    playerSocket.emit('cardConfirmPopup', { cardName: '免休卡', image: 'mianxiu', description: '免休卡：免除休息1次', reason, isTarget: true });
  }
  // 广播给所有玩家，显示bottomBar图片覆盖
  io.emit('cardConfirmOverlay', { targetPlayerId: playerId, cardName: '免休卡', cardImage: 'mianxiu', targetName: player.name, targetColor: player.color });
  return true;
}

// 统一处理发送到海南的逻辑，包含免休卡检查
function sendToIsland(playerId, callback) {
  const player = players.find(p => p.id === playerId);
  if (!player) return;

  const applyIsland = () => {
    setPlayerState(player, 'inJail', true);
    if (!player.inJail) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      if (callback) callback();
      return;
    }
    player.position = JAIL_ISLAND_ID;
    player.jailState = 'island';
    player.jailTurns = 0;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    if (callback) callback();
  };

  // 检查免休卡，使用onNotUsed回调确保callback被执行
  if (checkMianxiu(playerId, '进海南', { skipShowEndTurn: true, onNotUsed: applyIsland })) {
    // 有免休卡，等待用户选择
  } else {
    applyIsland();
  }
}

// 统一处理进监狱的逻辑，包含免休卡检查和钻石返还
function sendToJail(playerId, reason, callback) {
  const player = players.find(p => p.id === playerId);
  if (!player) return;

  const applyJail = () => {
    setPlayerState(player, 'inJail', true);
    if (!player.inJail) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      if (callback) callback();
      return;
    }
    player.jailState = 'jail';
    // 返还钻石
    if (returnDiamondIfHeld(player)) {
      io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
    }
    player.position = JAIL_JAIL_ID;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    if (callback) callback();
  };

  // 检查免休卡，使用onNotUsed回调确保callback被执行
  if (checkMianxiu(playerId, '进监狱区域', { skipShowEndTurn: true, onNotUsed: applyJail })) {
    // 有免休卡，等待用户选择
  } else {
    applyJail();
  }
}

// 统一处理进医院的逻辑，包含免休卡检查和钻石返还
function sendToHospital(playerId, reason, callback) {
  const player = players.find(p => p.id === playerId);
  if (!player) return;

  const applyHospital = () => {
    setPlayerState(player, 'inJail', true);
    if (!player.inJail) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      if (callback) callback();
      return;
    }
    player.jailState = 'hospital';
    // 返还钻石
    if (returnDiamondIfHeld(player)) {
      io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
    }
    player.position = JAIL_HOSPITAL_ID;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    if (callback) callback();
  };

  // 检查免休卡，使用onNotUsed回调确保callback被执行
  if (checkMianxiu(playerId, '进医院', { skipShowEndTurn: true, onNotUsed: applyHospital })) {
    // 有免休卡，等待用户选择
  } else {
    applyHospital();
  }
}

function applyRest(playerId, amount, message, socket, extraCallback, mianxiuExtra) {
  const player = players.find(p => p.id === playerId);
  if (!player) return;
  // 先更新E区显示消息
  io.emit('updateAreaE', { message: message });
  
  // 免休卡只影响休息效果，不影响F区结束按钮的显示
  const applyRestEffect = () => {
    player.restTurns = (player.restTurns || 0) + amount;
    if ((player.restTurns || 0) > 0) {
      checkPassivePetSkill(player, 'restTurns');
    }
    if (extraCallback) extraCallback();
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    if (socket) socket.emit('showEndTurn');
  };
  
  const skipRestEffect = () => {
    if (extraCallback) extraCallback();
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    if (socket) socket.emit('showEndTurn');
  };
  
  if (checkMianxiu(playerId, '休息', { 
    restAmount: amount, 
    restMessage: message, 
    ...(mianxiuExtra || {}),
    onNotUsed: applyRestEffect,
    onUsed: skipRestEffect
  })) {
    // 免休卡触发时，E区已显示消息，等待用户选择
  } else {
    player.restTurns = (player.restTurns || 0) + amount;
    if ((player.restTurns || 0) > 0) {
      checkPassivePetSkill(player, 'restTurns');
    }
    if (socket) socket.emit('showEndTurn');
    if (extraCallback) extraCallback();
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
  }
}

// 统一处理机遇卡选目标时的隐藏卡检查
// sourceId: 施加效果的玩家ID, targetId: 被选为目标的玩家ID
// effectFn: 无隐藏卡时执行的效果函数 (finalTarget, hiddenMsg) => void
// cancelFn: 被取消时的回调 () => void
// fantanFn: 反弹时的回调 (sourcePlayer) => void (可选)
function withHiddenCheck(sourceId, targetId, effectFn, cancelFn, fantanFn) {
  checkHiddenCardTarget(targetId, sourceId, (cancelled) => {
    if (cancelled) {
      if (cancelFn) cancelFn();
      pendingHiddenResult = null;
      return;
    }
    let finalTarget = players.find(p => p.id === targetId);
    let hiddenMsg = '';
    if (pendingHiddenResult && pendingHiddenResult.message) {
      hiddenMsg = pendingHiddenResult.message + '，';
    }
    if (pendingHiddenResult && pendingHiddenResult.newTargetId) {
      const newTarget = players.find(p => p.id === pendingHiddenResult.newTargetId);
      if (newTarget && !newTarget.bankrupt && !newTarget.sheltered) finalTarget = newTarget;
    }
    if (pendingHiddenResult && pendingHiddenResult.type === 'fantan' && fantanFn) {
      const source = players.find(p => p.id === sourceId);
      if (source) { fantanFn(source); pendingHiddenResult = null; return; }
    }
    pendingHiddenResult = null;
    effectFn(finalTarget, hiddenMsg);
  });
}

// 统一处理失去宠物前的保护卡检查
// playerId: 失去宠物的玩家ID, effectFn: 无保护卡时执行的效果函数
function withPetProtection(playerId, effectFn) {
  if (checkProtectedAsset(playerId, 'pet')) {
    const player = players.find(p => p.id === playerId);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket_emit_showEndTurn(playerId);
    return true; // 被保护卡挡住了
  }
  effectFn();
  return false;
}

// 统一处理失去地产前的保护卡检查
function withPropertyProtection(playerId, effectFn) {
  if (checkProtectedAsset(playerId, 'property')) {
    const player = players.find(p => p.id === playerId);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket_emit_showEndTurn(playerId);
    return true;
  }
  effectFn();
  return false;
}

// 辅助：给指定玩家发送showEndTurn
function socket_emit_showEndTurn(playerId) {
  const s = io.sockets.sockets.get(playerId);
  if (s) s.emit('showEndTurn');
}

function checkBankruptcy(player) {
  if (player.money >= 0 || player.bankrupt) return false;
  const myProps = board.filter(s => s.isProperty && s.owner === player.id);
  if (myProps.length > 0) {
    io.emit('nearBankrupt', { playerId: player.id, playerName: player.name, playerColor: player.color, properties: myProps.map(p => ({ id: p.id, name: p.name, price: p.price })) });
    return false;
  }
  return doBankrupt(player);
}

function doBankrupt(player) {
  player.bankrupt = true;
  player.money = 0;
  board.forEach(s => { if (s.owner === player.id) s.owner = null; });
  if (player.petImage) {
    if (!petPool.includes(player.petImage)) {
      petPool.push(player.petImage);
    }
    player.petImage = null;
    player.originalPetImage = null;
  }
  if (player.extraPets && player.extraPets.length > 0) {
    player.extraPets.forEach(pet => {
      if (!petPool.includes(pet)) {
        petPool.push(pet);
      }
    });
    player.extraPets = [];
  }
  if (dayunState && dayunState.playerId === player.id) {
    dayunState = null;
  }
  if (player.hasDiamond) {
    player.hasDiamond = false;
    diamondProgress = 0;
    diamondProgressPlayerId = null;
    diamondProgressPlayerColor = null;
    io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
  }
  const activePlayers = players.filter(p => !p.bankrupt);
  const rank = activePlayers.length + 1;
  player.money = -rank;
  io.emit('playerBankrupt', { playerId: player.id, playerName: player.name, playerColor: player.color, rank: rank, character: player.character, variant: player.variant });
  io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
  if (activePlayers.length <= 1) {
    const winner = activePlayers[0];
    if (winner) {
      const allRanks = players.map((p, i) => {
        if (p.bankrupt) return { name: p.name, color: p.color, rank: p.money < 0 ? -p.money : 1, character: p.character, variant: p.variant || '2' };
        return { name: p.name, color: p.color, rank: 1, character: p.character, variant: p.variant || '2' };
      }).sort((a, b) => a.rank - b.rank);
      // 游戏结束时清理所有临时保存数据
      clearTemporaryPlayerData();
      io.emit('gameOver', { winnerName: winner.name, winnerColor: winner.color, winnerCharacter: winner.character, winnerVariant: winner.variant || '2', rankings: allRanks });
    }
    return false;
  }
  return true;
}

let players = [];
let activeInLobby = new Set();
let diamondHolder = true;
let diamondInTransit = false;
let rouletteRemaining = 0;
let rouletteTargets = [];
let hezongFirstPlayerId = null;
let diamondProgress = 0;
let diamondProgressPlayerId = null;
let diamondProgressPlayerColor = null;

function returnDiamondIfHeld(player) {
  if (player && player.hasDiamond) {
    player.hasDiamond = false;
    diamondHolder = null;
    diamondProgress = 0;
    diamondProgressPlayerId = null;
    diamondProgressPlayerColor = null;
    return true;
  }
  return false;
}
let selectedCharacters = {};
let gameState = 'waiting';
let currentPlayerIndex = 0;
let currentDiceValue = 0;
let diceRolled = false;
let unrestrictedDice = 0;
let roundCounter = 0;
let lastAreaEMessage = ''; // 存储最后的E区消息
let xinjiangMoveState = null;
let xizangState = null;
let qinghaiState = null;
let guangxiState = null;
let guangxiOwnState = null;
let playerDiceRange = {};

let pinqianState = null;
let qiangjieState = null;
let auctionState = null;
let siheyuanState = null;
let texasHoldemState = null;
let texasFinalResults = {};
let texasClosedPlayers = new Set();
let texasWatchers = {};
let caboState = null;
let caboOpponentMap = {};
let caboSpectators = new Set();
let startGameVotes = new Set();
let restartVotes = new Set();
let kunlunState = null;
let kunlunFromTurn = false; // 昆仑TCK是否由到达昆仑格触发（而非轮数满触发）
let loadedGameSelectedCount = 0;
let loadedGameTotalPlayers = 0;
let pendingFgReports = {};
let fgReportTimer = null;
let loadedAreaFPerPlayer = {};
let loadedAreaGPerPlayer = {};
let xiaolicangdaoState = null;
let worldWarActive = false;
let sansiState = null;
let sansiOffset = 0;
let qiyuState = null;
let baohuQueryState = null; // 保护卡询问状态
let jiyuQueue = [];
let xianzhiState = null;
let tuisuanState = null;
let jiandieState = null;
let dizhuState = null;
let canzhiState = null;
let jiyuPendingState = null;
let yianState = null;
let fengkongState = null;
let mantianGuohaiState = null;
let hezuorenwuState = null;
let meihuoState = null;
let dalieState = null;
let dalieRefreshTimer = null;
let jiyuIndex = 139; // 从金花开始抽取（金花id:140，索引139）
let tudijianbingState = null;
let chuanxiaoState = null;
let fanzhuanState = null;
let xinlixueState = null;
let lianhuanjiState = null;
let meirenjiState = null;
let jidiState = null;
let gaokaoState = null;
let yexinjiaState = null;
let shoumaiState = null;
let anduchengcangState = null;
let qiankundanayiState = null;
let jiuBaState = null;
let yinyueState = null;
let gongtongState = null;
let yihuaState = null;
let hebaoState = null;
let huanranState = null;
let hengxingState = null;
let shengdongState = null;
let saidaoState = null;
let lihunState = null;
let qiutuState = null;
let chuangGuanState = null;
let shijieState = null;
let dayunState = null;
let dayunCars = [];
let nongminState = null;
let zhadanState = null;
let chuansongState = null;
let fengdiCardState = null;
let chuansongSelecting = false;
let shanxianSelecting = false;
let tingyeState = null;
let heikeState = null;
let longjuanfengState = null;
let bingdongState = null;
let shuimianState = null;
let xianhaiState = null;
let baozhengState = null;
let daoyingState = null;
let cunqianState = null;
let lunciState = null;
let jinhuaState = null;
let jingsuanState = null;
let pukepaiDeck = [];
const PUKEPAI_SUITS = ['spade', 'heart', 'diamond', 'club'];
const PUKEPAI_SUIT_NAMES = { spade: '黑桃', heart: '红心', diamond: '方块', club: '梅花' };

function initPukepaiDeck() {
  pukepaiDeck = [];
  for (let suitIdx = 0; suitIdx < 4; suitIdx++) {
    for (let rank = 1; rank <= 13; rank++) {
      pukepaiDeck.push({ suit: PUKEPAI_SUITS[suitIdx], rank, imageIndex: (rank - 1) * 4 + suitIdx });
    }
  }
}

function shufflePukepaiDeck() {
  for (let i = pukepaiDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pukepaiDeck[i], pukepaiDeck[j]] = [pukepaiDeck[j], pukepaiDeck[i]];
  }
}

function drawPukepaiCards(count) {
  if (pukepaiDeck.length < count) {
    initPukepaiDeck();
    shufflePukepaiDeck();
  }
  return pukepaiDeck.splice(0, count);
}

initPukepaiDeck();
shufflePukepaiDeck();
let luzhangPositions = [];

// 临时数据存储（玩家离线/断开时使用）
let temporaryPlayerDataStore = {};
// 永久保存数据（保存游戏时使用）
let savedGameData = null;
// 存储离线玩家信息
let disconnectedPlayers = {};

// 保存玩家临时数据（断开连接时调用）
function savePlayerTemporaryData(playerId) {
  const player = players.find(p => p.id === playerId);
  if (!player) return;
  
  temporaryPlayerDataStore[playerId] = {
    // 玩家基础数据
    id: player.id,
    name: player.name,
    color: player.color,
    character: player.character,
    variant: player.variant,
    money: player.money,
    position: player.position,
    bankrupt: player.bankrupt,
    cards: player.cards ? [...player.cards] : [],
    extraPets: player.extraPets ? [...player.extraPets] : [],
    petImage: player.petImage,
    petInfo: player.petImage ? getPetInfo(player.petImage) : null,
    petFlipped: player.petFlipped,
    snailStatus: player.snailStatus || false,
    snailCharges: player.snailCharges !== undefined ? player.snailCharges : 2,
    salary: player.salary,
    inJail: player.inJail,
    jailTurns: player.jailTurns,
    jailDice: player.jailDice,
    restTurns: player.restTurns,
    sheltered: player.sheltered,
    shelteredTurns: player.shelteredTurns,
    frozen: player.frozen,
    fengdiTurns: player.fengdiTurns || 0,
    shihua: player.shihua,
    extraTurns: player.extraTurns,
    fuwufeiExtraMove: player.fuwufeiExtraMove,
    guhuoDice: player.guhuoDice,
    guhuoBy: player.guhuoBy,
    shoumaiDice: player.shoumaiDice,
    yinyueDice: player.yinyueDice,
    yinyueBy: player.yinyueBy,
    shijieWar: player.shijieWar,
    diceEffects: player.diceEffects ? [...player.diceEffects] : [],
    daotui: player.daotui,
    bingdongTurns: player.bingdongTurns,
    bomingFrozen: player.bomingFrozen,
    jinzu: player.jinzu,
    tuolei: player.tuolei,
    wenji: player.wenji,
    dizhu: player.dizhu,
    fengkongDice: player.fengkongDice,
    syncedDice: player.syncedDice,
    syncedByName: player.syncedByName,
    cunqianRounds: player.cunqianRounds,
    statusIcons: player.statusIcons ? [...player.statusIcons] : [],
    hezongState: player.hezongState,
    hezongTurns: player.hezongTurns,
    hezongTarget: player.hezongTarget,
    petPlaceholder: player.petPlaceholder,
    zaie: player.zaie,
    snailCharges: player.snailCharges,
    loans: player.loans ? [...player.loans] : [],
    tempMoney: player.tempMoney,
    tempTurns: player.tempTurns,
    hasDiamond: player.hasDiamond,
    connected: false,
    // 临时状态数据
    currentDiceValue: currentDiceValue,
    lastAreaEMessage: lastAreaEMessage,
    diceRolled: diceRolled,
    currentPlayerIndex: currentPlayerIndex,
    // 当前激活的面板状态
    pendingCardConfirm: pendingCardConfirm ? { ...pendingCardConfirm } : null,
    longjuanfengState: longjuanfengState ? { ...longjuanfengState } : null,
    kunlunState: kunlunState ? { ...kunlunState } : null,
    sansiState: sansiState ? { ...sansiState } : null,
    qiyuState: qiyuState ? { ...qiyuState } : null,
    baohuQueryState: baohuQueryState ? { ...baohuQueryState } : null,
    auctionState: auctionState ? { ...auctionState } : null,
    jiyuPendingState: jiyuPendingState ? { ...jiyuPendingState } : null,
    timestamp: Date.now()
  };
  
  // 保存玩家拥有的地产
  const playerProperties = board.filter(s => s.owner === playerId).map(s => ({
    id: s.id,
    houseLevel: s.houseLevel,
    closed: s.closed,
    displayName: s.displayName,
    rentBonus: s.rentBonus
  }));
  temporaryPlayerDataStore[playerId].properties = playerProperties;
}

// 恢复玩家临时数据（重连时调用）
function restorePlayerTemporaryData(playerId) {
  const savedData = temporaryPlayerDataStore[playerId];
  if (!savedData) return null;
  
  const player = players.find(p => p.id === playerId);
  if (!player) return null;
  
  // 恢复玩家基础数据
  player.money = savedData.money;
  player.position = savedData.position;
  player.bankrupt = savedData.bankrupt;
  player.cards = savedData.cards ? [...savedData.cards] : [];
  player.extraPets = savedData.extraPets ? [...savedData.extraPets] : [];
  player.petImage = savedData.petImage;
  player.petFlipped = savedData.petFlipped;
  player.snailCharges = savedData.snailCharges;
  player.salary = savedData.salary;
  player.inJail = savedData.inJail;
  player.jailTurns = savedData.jailTurns;
  player.jailDice = savedData.jailDice;
  player.restTurns = savedData.restTurns;
  player.sheltered = savedData.sheltered;
  player.shelteredTurns = savedData.shelteredTurns;
  player.frozen = savedData.frozen;
  player.fengdiTurns = savedData.fengdiTurns || 0;
  player.shihua = savedData.shihua;
  player.extraTurns = savedData.extraTurns;
  player.fuwufeiExtraMove = savedData.fuwufeiExtraMove;
  player.guhuoDice = savedData.guhuoDice;
  player.guhuoBy = savedData.guhuoBy;
  player.shoumaiDice = savedData.shoumaiDice;
  player.yinyueDice = savedData.yinyueDice;
  player.yinyueBy = savedData.yinyueBy;
  player.shijieWar = savedData.shijieWar;
  player.diceEffects = savedData.diceEffects ? [...savedData.diceEffects] : [];
  player.daotui = savedData.daotui;
  player.bingdongTurns = savedData.bingdongTurns;
  player.bomingFrozen = savedData.bomingFrozen;
  player.jinzu = savedData.jinzu;
  player.tuolei = savedData.tuolei;
  player.wenji = savedData.wenji;
  player.dizhu = savedData.dizhu;
  player.fengkongDice = savedData.fengkongDice;
  player.syncedDice = savedData.syncedDice;
  player.syncedByName = savedData.syncedByName;
  player.cunqianRounds = savedData.cunqianRounds;
  player.statusIcons = savedData.statusIcons ? [...savedData.statusIcons] : [];
  player.hezongState = savedData.hezongState;
  player.hezongTurns = savedData.hezongTurns;
  player.hezongTarget = savedData.hezongTarget;
  player.petPlaceholder = savedData.petPlaceholder;
  player.zaie = savedData.zaie;
  player.loans = savedData.loans ? [...savedData.loans] : [];
  player.tempMoney = savedData.tempMoney;
  player.tempTurns = savedData.tempTurns;
  player.hasDiamond = savedData.hasDiamond;
  player.connected = true;
  
  // 恢复地产所有权
  if (savedData.properties) {
    savedData.properties.forEach(prop => {
      const space = board.find(s => s.id === prop.id);
      if (space) {
        space.owner = playerId;
        space.houseLevel = prop.houseLevel;
        space.closed = prop.closed;
        space.displayName = prop.displayName;
        space.rentBonus = prop.rentBonus;
      }
    });
  }
  
  // 恢复临时状态数据
  if (savedData.currentDiceValue !== undefined) currentDiceValue = savedData.currentDiceValue;
  if (savedData.lastAreaEMessage) lastAreaEMessage = savedData.lastAreaEMessage;
  
  // 返回保存的临时状态，供调用者决定是否恢复
  return {
    diceRolled: savedData.diceRolled,
    currentPlayerIndex: savedData.currentPlayerIndex,
    pendingCardConfirm: savedData.pendingCardConfirm,
    longjuanfengState: savedData.longjuanfengState,
    kunlunState: savedData.kunlunState,
    sansiState: savedData.sansiState,
    qiyuState: savedData.qiyuState,
    baohuQueryState: savedData.baohuQueryState,
    auctionState: savedData.auctionState,
    jiyuPendingState: savedData.jiyuPendingState,
    timestamp: savedData.timestamp
  };
}

// 清理所有临时保存数据
function clearTemporaryPlayerData() {
  temporaryPlayerDataStore = {};
}

function weightedRandomQiyu() {
  const totalWeight = qiyuList.reduce((s, q) => s + (q.weight !== undefined ? q.weight : 1), 0);
  let r = Math.random() * totalWeight;
  for (const q of qiyuList) {
    r -= (q.weight !== undefined ? q.weight : 1);
    if (r <= 0) return q;
  }
  return qiyuList[qiyuList.length - 1];
}

function processQiyu(qiyuId, socket) {
  const current = players[currentPlayerIndex];
  if (!current) return;

  if (qiyuId === 1) {
    io.emit('updateAreaE', { message: '假奇遇：什么事都没发生' });
    socket.emit('showEndTurn');
  } else if (qiyuId === 2) {
    const myProps = board.filter(s => s.isProperty && s.owner === current.id);
    if (myProps.length === 0) {
      io.emit('updateAreaE', { message: '空中楼阁：你随机某地修建空中楼阁，路费+15（没有地产）' });
      socket.emit('showEndTurn');
      return;
    }
    const randomProp = myProps[Math.floor(Math.random() * myProps.length)];
    randomProp.rentBonus = (randomProp.rentBonus || 0) + 15;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `空中楼阁：${randomProp.name}修建空中楼阁，路费+15` });
    socket.emit('showEndTurn');
  } else if (qiyuId === 3) {
    previewMoney(current.id, 80);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `中彩票：${coloredName(current.name, current.color)}+80` });
    socket.emit('showEndTurn');
  } else if (qiyuId === 4) {
    const activePlayers = players.filter(p => !p.bankrupt);
    const aliveIds = activePlayers.map(p => p.id);
    io.emit('updateAreaE', { message: '极地求生：从当前玩家开始选择开枪/反弹（无人打你你会死）/空枪' });
    startJidiRound(aliveIds, 1);
  } else if (qiyuId === 5) {
    chuangGuanState = { playerId: current.id, bonus: 6, successRate: 9 };
    io.emit('chuangGuanStart', { playerId: current.id, bonus: 6, successRate: 9 });
  } else if (qiyuId === 6) {
    const others = getValidTargets(current.id);
    if (others.length === 0) {
      io.emit('updateAreaE', { message: '改朝换代：没有合适的目标' });
      socket.emit('showEndTurn');
      return;
    }
    io.emit('gaichaoStart', { playerId: current.id });
  } else if (qiyuId === 7) {
    const others = getValidTargets(current.id);
    if (others.length === 0) {
      io.emit('updateAreaE', { message: '拜金主义：没有合适的目标' });
      socket.emit('showEndTurn');
      return;
    }
    io.emit('baijinStart', { playerId: current.id });
  } else if (qiyuId === 8) {
    io.emit('renwoxingStart', { playerId: current.id });
  } else if (qiyuId === 9) {
    const myProps = board.filter(s => s.isProperty && s.owner === current.id);
    const others = getValidTargets(current.id);
    if (myProps.length === 0 || others.length === 0) {
      io.emit('updateAreaE', { message: '农民起义：选三块地，与他人随机3块地互换（没有合适的目标）' });
      socket.emit('showEndTurn');
      return;
    }
    nongminState = { playerId: current.id, selectedPropIds: [], phase: 'waiting', propCount: myProps.length };
    io.emit('nongminStart', { playerId: current.id, propCount: myProps.length });
    io.emit('updateAreaE', { message: '农民起义：选三块地，与他人随机3块地互换（不足3视为3）' });
  } else if (qiyuId === 10) {
    previewMoney(current.id, -40);
    io.emit('updateAreaE', { message: `噩耗：${coloredName(current.name, current.color)}-40` });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('showEndTurn');
  } else if (qiyuId === 11) {
    worldWarActive = true;
    players.forEach(p => { if (!p.bankrupt) p.shijieWar = true; });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: '世界大战：每人回合结束-10直到游戏结束' });
    socket.emit('showEndTurn');
  } else if (qiyuId === 12) {
    previewMoney(current.id, 66);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `挖到宝藏：${coloredName(current.name, current.color)}+66` });
    socket.emit('showEndTurn');
  } else if (qiyuId === 13) {
    previewMoney(current.id, 100);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `印假钞：${coloredName(current.name, current.color)}+100` });
    socket.emit('showEndTurn');
  } else if (qiyuId === 14) {
    current.salary = (current.salary || 0) + 30;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `升官：${coloredName(current.name, current.color)}工资+30` });
    socket.emit('showEndTurn');
  } else if (qiyuId === 15 || qiyuId === 16 || qiyuId === 17) {
    const qiyu = qiyuList.find(q => q.id === qiyuId);
    io.emit('updateAreaE', { message: `${qiyu.name}：${qiyu.desc}` });
    io.emit('qiyuSelectTarget', { playerId: current.id, qiyuId });
  } else if (qiyuId === 18) {
    const myProps = board.filter(s => s.isProperty && s.owner === current.id);
    if (myProps.length === 0) {
      io.emit('updateAreaE', { message: '僵尸封城：随机地产-2（无地产）' });
      socket.emit('showEndTurn');
      return;
    }
    const shuffled = myProps.sort(() => Math.random() - 0.5);
    const count = Math.min(2, shuffled.length);
    const removed = shuffled.slice(0, count);
    const names = [];
    removed.forEach(s => {
      withPropertyProtection(current.id, () => {
        s.owner = null;
        s.houseLevel = 0;
        names.push(s.name);
      });
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    if (names.length > 0) {
      io.emit('updateAreaE', { message: `僵尸封城：随机地产-2（${names.join('，')}）` });
    }
    socket.emit('showEndTurn');
  } else if (qiyuId === 19) {
    const others = getValidTargets(current.id);
    const lostNames = [];
    others.forEach(p => {
      if (p.petImage) {
        withPetProtection(p.id, () => {
          lostNames.push(coloredName(p.name, p.color));
          if (!petPool.includes(p.petImage)) {
            petPool.push(p.petImage);
          }
          p.petImage = null;
          p.originalPetImage = null;
          p.cwqImage = null;
        });
      }
    });
    let gotPet = false;
    if (petPool.length > 0) {
      const randomIndex = Math.floor(Math.random() * petPool.length);
      const randomPet = petPool.splice(randomIndex, 1)[0];
      if (!current.petImage) {
        current.petImage = randomPet;
      } else {
        if (!current.extraPets) current.extraPets = [];
        current.extraPets.push(randomPet);
      }
      gotPet = true;
    }
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    const lostPart = lostNames.length > 0 ? lostNames.join('，') + '失去宠物' : '无人失去宠物';
    const gotPart = gotPet ? `${coloredName(current.name, current.color)}获得1随机宠物` : '';
    io.emit('updateAreaE', { message: '归还：所有他人失去宠物，你免费获得1随机宠物' });
    socket.emit('showEndTurn');
  } else if (qiyuId === 20) {
    // 资本主义罪：进监狱（使用统一函数）
    sendToJail(current.id, '资本主义罪', () => {
      io.emit('updateAreaE', { message: '资本主义罪：进监狱' });
      socket.emit('showEndTurn');
    });
  } else if (qiyuId === 21) {
    previewMoney(current.id, -40);
    const others = getValidTargets(current.id);
    others.forEach(p => {
      previewMoney(p.id, -60);
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: '同归于尽：-40，每个他人-60' });
    socket.emit('showEndTurn');
  } else if (qiyuId === 22) {
    const others = getValidTargets(current.id);
    const downgradedNames = [];
    others.forEach(p => {
      const myProps = board.filter(s => s.isProperty && s.owner === p.id && s.houseLevel > 0);
      if (myProps.length > 0) {
        downgradedNames.push(coloredName(p.name, p.color));
        myProps.forEach(s => { s.houseLevel -= 1; });
      }
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    const downPart = downgradedNames.length > 0 ? downgradedNames.join('，') + '房屋降级' : '无人有房屋可降级';
    io.emit('updateAreaE', { message: '荒漠化：所有他人的房屋降级' });
    socket.emit('showEndTurn');
  } else if (qiyuId === 23) {
    io.emit('updateAreaE', { message: '高考：群体竞价拼钱，按名次依次获得50-20-0-负10-负20-负50' });
    const activePlayers = players.filter(p => !p.bankrupt);
    gaokaoState = {
      players: activePlayers.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        number: 0,
        confirmed: false
      })),
      rewards: [50, 20, 0, -10, -20, -50]
    };
    activePlayers.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) {
        s.emit('gaokaoStart', {
          playerName: p.name,
          playerColor: p.color
        });
      }
    });
  } else if (qiyuId === 24) {
    io.emit('updateAreaE', { message: '野心家：选择+10或争夺60' });
    const activePlayers = players.filter(p => !p.bankrupt);
    yexinjiaState = {
      choices: {},
      playerIds: activePlayers.map(p => p.id)
    };
    activePlayers.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) {
        s.emit('yexinjiaChoice', { playerId: p.id });
      }
    });
  } else if (qiyuId === 25) {
    io.emit('updateAreaE', { message: '大慈善家：可将你所有现金交给他人，然后+50' });
    socket.emit('cishanjiaChoice');
  } else if (qiyuId === 26) {
    const halfMoney = Math.floor(current.money / 2);
    const others = getValidTargets(current.id);
    if (others.length > 0 && halfMoney > 0) {
      const share = Math.floor(halfMoney / others.length);
      previewMoney(current.id, -halfMoney);
      others.forEach(p => {
        previewMoney(p.id, share);
      });
      const remainder = halfMoney - share * others.length;
      if (remainder > 0) {
        current.money += remainder;
      }
    }
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: '共产主义：将你一半的现金给所有他人平分' });
    socket.emit('showEndTurn');
  } else if (qiyuId === 27) {
    io.emit('updateAreaE', { message: '酒吧：去酒吧人数≤一半各+35，在家的+5' });
    const activePlayers = players.filter(p => !p.bankrupt);
    jiuBaState = {
      choices: {},
      playerIds: activePlayers.map(p => p.id),
      totalPlayers: activePlayers.length
    };
    activePlayers.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) s.emit('jiubaChoice', { playerId: p.id });
    });
  } else if (qiyuId === 28) {
    const myProps = board.filter(s => s.isProperty && s.owner === current.id && s.houseLevel < 4);
    if (myProps.length === 0) {
      io.emit('updateAreaE', { message: '大跃进：没有可升级的房屋（全部已满级）' });
    } else {
      myProps.forEach(s => { s.houseLevel += 1; });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: '大跃进：你的全部房屋升级' });
    }
    socket.emit('showEndTurn');
  } else if (qiyuId === 29) {
    const activePlayers = players.filter(p => !p.bankrupt);
    const startIndex = activePlayers.findIndex(p => p.id === current.id);
    const reordered = [...activePlayers.slice(startIndex), ...activePlayers.slice(0, startIndex)];
    yinyueState = {
      diceMap: {},
      playerOrder: reordered.map(p => p.id),
      currentIndex: 0,
      commanderId: current.id
    };
    const firstPlayer = reordered[0];
    io.emit('updateAreaE', { message: `音乐指挥：请指定${coloredName(firstPlayer.name, firstPlayer.color)}的点数` });
    socket.emit('yinyueDiceChoice');
  } else if (qiyuId === 30) {
    const myPropCount = board.filter(s => s.isProperty && s.owner === current.id).length;
    io.emit('updateAreaE', { message: `共同富裕：其他人可失去最低价地产，然后若和你地产数（${myPropCount}）相同各+20；否则-30` });
    const others = getValidTargets(current.id);
    gongtongState = {
      choices: {},
      playerIds: others.map(p => p.id),
      currentPlayerId: current.id,
      myPropCount: myPropCount
    };
    others.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      const pPropCount = board.filter(s => s.isProperty && s.owner === p.id).length;
      const pProps = board.filter(s => s.isProperty && s.owner === p.id);
      const cheapestName = pProps.length > 0 ? pProps.reduce((min, s) => s.price < min.price ? s : min, pProps[0]).name : '';
      if (s) s.emit('gongtongChoice', { playerId: p.id, propCount: pPropCount, cheapestName });
    });
  } else if (qiyuId === 31) {
    current.shihua = true;
    checkPassivePetSkill(current, 'shihua');
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: '石化：不能移动直到判5-6' });
    socket.emit('showEndTurn');
  } else if (qiyuId === 32) {
    const othersHaveHouses = players.filter(p => p.id !== current.id && !p.bankrupt && board.some(s => s.isProperty && s.owner === p.id && s.houseLevel > 0));
    const myProps = board.filter(s => s.isProperty && s.owner === current.id);
    let suffix = '';
    if (othersHaveHouses.length === 0) suffix += '（没有房产）';
    if (myProps.length === 0) suffix += '（没有地产）';
    io.emit('updateAreaE', { message: `移花接木：将他人1栋房屋转移给自己${suffix}` });
    if (othersHaveHouses.length === 0 || myProps.length === 0) {
      socket.emit('showEndTurn');
      return;
    }
    yihuaState = {
      phase: 'selectSource',
      sourceId: null,
      commanderId: current.id
    };
    socket.emit('yihuaSelectSource');
  } else if (qiyuId === 33) {
    io.emit('updateAreaE', { message: '核爆炸：请选择一排' });
    hebaoState = { commanderId: current.id };
    socket.emit('hebaoSelectRow');
  } else if (qiyuId === 34) {
    const others = getValidTargets(current.id);
    const lostInfo = [];
    others.forEach(p => {
      const myProps = board.filter(s => s.isProperty && s.owner === p.id);
      if (myProps.length > 0) {
        const highest = myProps.reduce((max, s) => s.price > max.price ? s : max, myProps[0]);
        withPropertyProtection(p.id, () => {
          highest.owner = null;
          highest.houseLevel = 0;
          lostInfo.push(`${coloredName(p.name, p.color)}${highest.name}`);
        });
      }
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    const msg = lostInfo.length > 0 ? `恐怖份子，令所有他人失去地价最高的一块地（${lostInfo.join('，')}）` : '恐怖份子，他人无地产';
    io.emit('updateAreaE', { message: msg });
    socket.emit('showEndTurn');
  } else if (qiyuId === 35) {
    io.emit('updateAreaE', { message: '焕然一新：请选择一排' });
    huanranState = { commanderId: current.id };
    socket.emit('huanranSelectRow');
  } else if (qiyuId === 36) {
    const othersWithProps = getValidTargets(current.id).filter(p => board.some(s => s.isProperty && s.owner === p.id));
    if (othersWithProps.length === 0) {
      io.emit('updateAreaE', { message: '横行霸道：强占某人随机2块地产（没有合适的目标）' });
      socket.emit('showEndTurn');
      return;
    }
    hengxingState = { commanderId: current.id };
    io.emit('qiyuSelectTarget', { playerId: current.id, qiyuId: 36 });
  } else if (qiyuId === 37) {
    const others = getValidTargets(current.id);
    if (others.length > 0) {
      const names = others.map(p => coloredName(p.name, p.color)).join('，');
      const processQueue = (queue, index) => {
        if (index >= queue.length) {
          io.emit('updateAreaE', { message: `白色恐怖：令所有他人进监狱（${names}）` });
          socket.emit('showEndTurn');
          return;
        }
        const p = queue[index];
        sendToJail(p.id, '白色恐怖', () => {
          processQueue(queue, index + 1);
        });
      };
      processQueue(others, 0);
    } else {
      io.emit('updateAreaE', { message: '白色恐怖：令所有他人进监狱（没有合适的目标）' });
      socket.emit('showEndTurn');
    }
  } else if (qiyuId === 38) {
    const others = getValidTargets(current.id);
    if (others.length > 0) {
      const names = others.map(p => coloredName(p.name, p.color)).join('，');
      const processQueue = (queue, index) => {
        if (index >= queue.length) {
          io.emit('updateAreaE', { message: `年假：令所有他人到海南（${names}）` });
          socket.emit('showEndTurn');
          return;
        }
        const p = queue[index];
        sendToIsland(p.id, () => {
          processQueue(queue, index + 1);
        });
      };
      processQueue(others, 0);
    } else {
      io.emit('updateAreaE', { message: '年假：令所有他人到海南（没有合适的目标）' });
      socket.emit('showEndTurn');
    }
  } else if (qiyuId === 39) {
    current.cards = [];
    if (current.petImage) {
      withPetProtection(current.id, () => {
        if (!petPool.includes(current.petImage)) {
          petPool.push(current.petImage);
        }
        current.petImage = null;
        current.originalPetImage = null;
      });
    }
    if (current.extraPets && current.extraPets.length > 0) {
      current.extraPets.forEach(pet => {
        if (!petPool.includes(pet)) {
          petPool.push(pet);
        }
      });
    }
    current.extraPets = [];
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: '孤家寡人：失去全部卡和宠物' });
    socket.emit('showEndTurn');
  } else if (qiyuId === 40) {
    const qiyu = qiyuList.find(q => q.id === 40);
    io.emit('updateAreaE', { message: `金门：${qiyu ? qiyu.desc : ''}` });
    socket.emit('jinmenShowOptions');
  } else if (qiyuId === 41) {
    const othersWithProps = getValidTargets(current.id).filter(p => board.some(s => s.isProperty && s.owner === p.id));
    if (othersWithProps.length === 0) {
      io.emit('updateAreaE', { message: '声东击西：声明他人地产卡A并进攻B，此人保护1张地卡（没有合适的目标）' });
      socket.emit('showEndTurn');
      return;
    }
    shengdongState = { commanderId: current.id, targetId: null, declared: null, attacked: null, protected: null };
    io.emit('qiyuSelectTarget', { playerId: current.id, qiyuId: 41 });
  } else if (qiyuId === 42) {
    io.emit('updateAreaE', { message: '赛道：每人选择点数1-5' });
    const activePlayers = players.filter(p => !p.bankrupt);
    saidaoState = {
      choices: {},
      playerIds: activePlayers.map(p => p.id)
    };
    activePlayers.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) s.emit('saidaoChoice', { playerId: p.id });
    });
  } else if (qiyuId === 43) {
    const othersWithProps = getValidTargets(current.id).filter(p => board.some(s => s.isProperty && s.owner === p.id));
    if (othersWithProps.length === 0) {
      io.emit('updateAreaE', { message: '离婚：可将所有地产卡交给他人，其分成两份，你获得1份（没有合适的目标）' });
      socket.emit('showEndTurn');
      return;
    }
    lihunState = { commanderId: current.id, targetId: null };
    io.emit('qiyuSelectTarget', { playerId: current.id, qiyuId: 43 });
  } else if (qiyuId === 44) {
    const activePlayers = players.filter(p => !p.bankrupt);
    if (activePlayers.length < 2) {
      io.emit('updateAreaE', { message: '囚徒：选两个人当囚徒，各自选择合作/背叛（没有合适的目标）' });
      socket.emit('showEndTurn');
      return;
    }
    io.emit('updateAreaE', { message: '囚徒：请选择2名玩家' });
    qiutuState = { commanderId: current.id, selectedIds: [], choices: {} };
    socket.emit('qiutuSelectPlayers', { playerId: current.id });
  } else if (qiyuId === 45) {
    socket.emit('kanuSelectCards', { cards: cardData });
  } else if (qiyuId === 46) {
    const others = players.filter(p => p.id !== current.id && !p.bankrupt);
    const closedNames = [];
    others.forEach(p => {
      const myProps = board.filter(s => s.isProperty && s.owner === p.id && !s.closed);
      if (myProps.length > 0) {
        closedNames.push(coloredName(p.name, p.color));
        myProps.forEach(s => { s.closed = true; });
      }
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    const msg = closedNames.length > 0 ? `流感：${closedNames.join('，')}的地产停业` : '流感：他人无地产';
    io.emit('updateAreaE', { message: msg });
    socket.emit('showEndTurn');
  } else if (qiyuId === 47) {
    grantTempMoney(current.id, 300, 3);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `吸毒：${coloredName(current.name, current.color)}临时金钱+300` });
    socket.emit('showEndTurn');
  } else if (qiyuId === 48) {
    current.zaie = (current.zaie || 0) + 10;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `缠身：${coloredName(current.name, current.color)}获得灾厄10回合` });
    socket.emit('showEndTurn');
  } else if (qiyuId === 49) {
    cardData.forEach(card => {
      if (!card.hiddenBase && card.id !== 6) {
        addCardToPlayer(current, card);
      }
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `卡皇：${coloredName(current.name, current.color)}获得全套卡片` });
    socket.emit('showEndTurn');
  }
}//奇遇

let qiyuIndex = 0; // 奇遇顺序索引

// 统一筛选有效目标玩家（排除放逐区）
function getValidTargets(excludePlayerId) {
  return players.filter(p => 
    p.id !== excludePlayerId && 
    !p.bankrupt && 
    !p.inJail && 
    p.position !== 1 // 排除在棋盘监狱格子（财产罪）的玩家
  );
}

function weightedRandomJiyu() {
  if (jiyuQueue.length > 0) {
    return jiyuQueue.shift();
  }
  // 默认：按weight随机抽取
  const totalWeight = jiyuList.reduce((s, j) => s + (j.weight !== undefined ? j.weight : 1), 0);
  let r = Math.random() * totalWeight;
  let picked = jiyuList[jiyuList.length - 1];
  for (const j of jiyuList) {
    r -= (j.weight !== undefined ? j.weight : 1);
    if (r <= 0) { picked = j; break; }
  }
  return picked;
}

function applyDaoyingEffect(player, choice) {
  if (choice === '-7') {
    previewMoney(player.id, -7);
  } else if (choice === '到监狱') {
    // 倒影效果：到监狱（使用统一函数）
    sendToJail(player.id, '倒影', () => {});
  } else if (choice === '工资-3') {
    player.salary = Math.max(1, (player.salary || 10) - 3);
  }
}

function daoyingEffectText(choice) {
  if (choice === '-7') return '-7';
  if (choice === '到监狱') return '到监狱';
  if (choice === '工资-3') return '工资-3';
  return choice;
}




function startJidiRound(aliveIds, roundNum) {
  jidiState = { choices: {}, aliveIds, deadOrder: [], deadCauses: {}, roundResults: [], roundNum: roundNum || 1 };
  aliveIds.forEach(id => { jidiState.choices[id] = null; });
  const current = players[currentPlayerIndex];
  const startIdx = aliveIds.indexOf(current.id);
  const ordered = [];
  for (let i = 0; i < aliveIds.length; i++) {
    ordered.push(aliveIds[(startIdx + i) % aliveIds.length]);
  }
  jidiState.orderedIds = ordered;
  io.emit('jidiChoose', { aliveIds, orderedIds: ordered, deadOrder: jidiState.deadOrder, deadCauses: jidiState.deadCauses });
}

function resolveJidi() {
  const { choices, orderedIds, aliveIds } = jidiState;
  const deadThisRound = [];
  const reboundSuccess = new Set();
  const deadCauses = {};

  for (const shooterId of orderedIds) {
    const choice = choices[shooterId];
    if (!choice) continue;
    if (deadThisRound.includes(shooterId)) continue;

    if (choice.action === 'shoot') {
      const targetId = choice.target;
      if (deadThisRound.includes(targetId)) continue;
      const targetChoice = choices[targetId];
      if (targetChoice && targetChoice.action === 'rebound') {
        deadThisRound.push(shooterId);
        reboundSuccess.add(targetId);
        deadCauses[shooterId] = { type: 'rebound', byId: targetId };
      } else {
        deadThisRound.push(targetId);
        deadCauses[targetId] = { type: 'shot', byId: shooterId };
      }
    }
  }

  for (const id of orderedIds) {
    const choice = choices[id];
    if (choice && choice.action === 'rebound' && !reboundSuccess.has(id) && !deadThisRound.includes(id)) {
      deadThisRound.push(id);
      deadCauses[id] = { type: 'selfRebound' };
    }
  }

  const newDeadOrder = [...new Set([...jidiState.deadOrder, ...deadThisRound])];
  const newDeadCauses = { ...(jidiState.deadCauses || {}), ...deadCauses };
  const newAlive = aliveIds.filter(id => !deadThisRound.includes(id));

  const allPlayers = players.filter(p => !p.bankrupt);

  const current = players[currentPlayerIndex];
  const startIdx = newAlive.indexOf(current.id);
  let newOrdered = [];
  if (startIdx >= 0) {
    for (let i = 0; i < newAlive.length; i++) {
      newOrdered.push(newAlive[(startIdx + i) % newAlive.length]);
    }
  } else {
    newOrdered = [...newAlive];
  }

  if (newAlive.length <= 1) {
    const ranking = [];
    const surviving = newAlive.length === 1 ? newAlive[0] : null;
    let rank = allPlayers.length;
    for (const deadId of newDeadOrder) {
      ranking.push({ id: deadId, rank });
      rank--;
    }
    if (surviving) {
      ranking.push({ id: surviving, rank: 1 });
    }
    const rewards = { 1: 50, 2: 20, 3: 10, 4: -10, 5: -20, 6: -50 };
    ranking.sort((a, b) => a.rank - b.rank);
    let resultMsg = '';
    for (const r of ranking) {
      const p = players.find(pp => pp.id === r.id);
      if (!p) continue;
      const reward = rewards[r.rank] || 0;
      previewMoney(p.id, reward);
      resultMsg += `${coloredName(p.name, p.color)}${reward >= 0 ? '+' : ''}${reward}，`;
    }
    if (resultMsg.endsWith('，')) resultMsg = resultMsg.slice(0, -1);
    jidiState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
    io.emit('jidiEnd', { resultMsg });
    return;
  }

  const nextRound = (jidiState.roundNum || 1) + 1;
  jidiState.aliveIds = newAlive;
  jidiState.deadOrder = newDeadOrder;
  jidiState.deadCauses = newDeadCauses;
  jidiState.choices = {};
  jidiState.orderedIds = newOrdered;
  jidiState.roundNum = nextRound;
  newAlive.forEach(id => { jidiState.choices[id] = null; });
  io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
  io.emit('jidiRoundEnd', { roundNum: jidiState.roundNum - 1, deadThisRound, nextRound });
  setTimeout(() => {
    if (!jidiState) return;
    io.emit('jidiChoose', { aliveIds: newAlive, orderedIds: newOrdered, deadOrder: newDeadOrder, deadCauses: newDeadCauses });
  }, 1500);
}

function broadcastSync() {
  io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter, kunlunState });
}

function generateMazeServer() {
  const C = 15, R = 23, T = 345;
  const DR = [-1, 1, 0, 0], DC = [0, 0, -1, 1];
  for (let attempt = 0; attempt < 100; attempt++) {
    const a = new Array(T).fill(0);
    for (let i = 0; i < T; i++) {
      const r = (i / C) | 0, c = i % C;
      if (r === 0 || r === R - 1 || c === 0 || c === C - 1) a[i] = 2;
    }
    const bc = [];
    for (let i = 0; i < T; i++) {
      const r = (i / C) | 0, c = i % C;
      if (a[i] === 2 && !((r === 0 || r === R - 1) && (c === 0 || c === C - 1))) bc.push(i);
    }
    const ent = bc[(Math.random() * bc.length) | 0];
    a[ent] = 4;
    const entR = (ent / C) | 0, entC = ent % C;
    const entSide = entR === 0 ? 0 : entR === R - 1 ? 1 : entC === 0 ? 2 : 3;
    const oppSides = entSide === 0 ? [1, 2, 3] : entSide === 1 ? [0, 2, 3] : entSide === 2 ? [0, 1, 3] : [0, 1, 2];
    const exitCandidates = [];
    for (const idx of bc) {
      if (idx === ent) continue;
      const ir = (idx / C) | 0, ic = idx % C;
      const side = ir === 0 ? 0 : ir === R - 1 ? 1 : ic === 0 ? 2 : 3;
      if (!oppSides.includes(side)) continue;
      if (Math.abs(ir - entR) < 8 && Math.abs(ic - entC) < 8) continue;
      exitCandidates.push(idx);
    }
    let pos = ent, pathLen = 0;
    const mainPath = [ent];
    let stuck = false;
    while (pathLen < 20) {
      const r = (pos / C) | 0, c = pos % C;
      const nbrs = [];
      for (let d = 0; d < 4; d++) {
        const nr = r + DR[d], nc = c + DC[d];
        if (nr > 0 && nr < R - 1 && nc > 0 && nc < C - 1) {
          const np = nr * C + nc;
          if (a[np] === 0) {
            let adj = 0;
            for (let dd = 0; dd < 4; dd++) {
              const nnr = nr + DR[dd], nnc = nc + DC[dd];
              if (nnr >= 0 && nnr < R && nnc >= 0 && nnc < C) {
                const nn = nnr * C + nnc;
                if (a[nn] === 1 && nn !== pos) adj++;
              }
            }
            if (adj === 0) nbrs.push(np);
          }
        }
      }
      if (nbrs.length === 0) { stuck = true; break; }
      const next = nbrs[(Math.random() * nbrs.length) | 0];
      a[next] = 1;
      pos = next;
      pathLen++;
      mainPath.push(next);
    }
    if (stuck) continue;
    let exitFound = false;
    for (let extra = 0; extra < 200; extra++) {
      const r = (pos / C) | 0, c = pos % C;
      const borderNbrs = [];
      const innerNbrs = [];
      for (let d = 0; d < 4; d++) {
        const nr = r + DR[d], nc = c + DC[d];
        if (nr >= 0 && nr < R && nc >= 0 && nc < C) {
          const np = nr * C + nc;
          if (a[np] === 2 && exitCandidates.includes(np)) borderNbrs.push(np);
          else if (a[np] === 0 && nr > 0 && nr < R - 1 && nc > 0 && nc < C - 1) {
            let adj = 0;
            for (let dd = 0; dd < 4; dd++) {
              const nnr = nr + DR[dd], nnc = nc + DC[dd];
              if (nnr >= 0 && nnr < R && nnc >= 0 && nnc < C) {
                const nn = nnr * C + nnc;
                if (a[nn] === 1 && nn !== pos) adj++;
              }
            }
            if (adj === 0) innerNbrs.push(np);
          }
        }
      }
      if (borderNbrs.length > 0 && pathLen >= 20) {
        const ex = borderNbrs[(Math.random() * borderNbrs.length) | 0];
        a[ex] = 3;
        exitFound = true;
        break;
      }
      if (innerNbrs.length === 0) break;
      const next = innerNbrs[(Math.random() * innerNbrs.length) | 0];
      a[next] = 1;
      pos = next;
      pathLen++;
      mainPath.push(next);
    }
    if (!exitFound) continue;
    const mainPathSet = new Set(mainPath);
    const nearMain = new Set();
    for (const p of mainPath) {
      const pr = (p / C) | 0, pc = p % C;
      for (let d = 0; d < 4; d++) {
        const nr = pr + DR[d], nc = pc + DC[d];
        if (nr > 0 && nr < R - 1 && nc > 0 && nc < C - 1) {
          const np = nr * C + nc;
          if (!mainPathSet.has(np)) nearMain.add(np);
        }
      }
    }
    for (let x = 0; x < T; x++) {
      if (a[x] === 0) {
        if (mainPathSet.has(x)) {
          a[x] = 1;
        } else {
          const rr = (x / C) | 0, cc = x % C;
          if (rr === 1 || rr === R - 2 || cc === 1 || cc === C - 2 || nearMain.has(x)) {
            a[x] = Math.random() < 0.34 ? 2 : 1;
          } else {
            a[x] = Math.random() < 0.28 ? 2 : 1;
          }
        }
      }
    }
    return { grid: a, entrance: ent };
  }
  const a = new Array(T).fill(1);
  for (let i = 0; i < T; i++) { const r = (i / C) | 0, c = i % C; if (r === 0 || r === R - 1 || c === 0 || c === C - 1) a[i] = 2; }
  a[1 * C + 1] = 4;
  a[(R - 2) * C + (C - 2)] = 3;
  return { grid: a, entrance: 1 * C + 1 };
}

let guashaState = null;
let jiaoyiState = null;
let zemuerqiState = null;
let zibaoState = null;
let jihuiState = null;
let shenbingState = null;
let banjiaState = null;
let hunshuiState = null;
let lianheState = null;
let dacaoState = null;
let haiziState = null;
let erenState = null;
let qiangmaiState = null;
let diaohuState = null;
let paozhuanState = null;
let yuanjiaoState = null;
let shunyiState = null;
let zhilijiemuState = null;
let zhongjinState = null;
let wanrenmiState = null;
let tongbuState = null;
let chehuoState = null;
let nantiState = null;
let shuiguojiState = null;
let xitieshiState = null;
let lijianState = null;
let wuzhongshengyouState = null;
let gongchengState = null;
let pendingBaihuState = null;
let zheRenFengState = null;

let petPool = [];
for (let i = 1; i <= 18; i++) {
  petPool.push(`${i}.png`);
}

io.on('connection', (socket) => {
  socket.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, roundCounter });
  socket.emit('mzNames', { surnames: mzSurnames, givenNames: mzGivenNames });

  socket.on('inLobby', () => {
    activeInLobby.add(socket.id);
  });

  socket.on('join', ({ name, character, variant }) => {
    const colorMatch = character.match(/^(hong|cheng|huang|haung|lv|lan|zi)(\d*)$/);
    const charColor = colorMatch ? (colorMatch[1] === 'haung' ? 'huang' : colorMatch[1]) : character;
    const charVariant = variant || (colorMatch ? colorMatch[2] : '');
    const charName = charColor + charVariant;

    const existingPlayer = players.find(p => p.name === name && p.character === charColor && p.variant === charVariant);

    if (existingPlayer) {
      // 恢复玩家临时数据（如果有保存的数据）
      const oldId = existingPlayer.id;
      restorePlayerTemporaryData(oldId);
      // 删除旧的临时数据存储
      delete temporaryPlayerDataStore[oldId];
      // 更新pendingCardConfirm的playerId为新socket.id（在更新existingPlayer.id之前）
      if (pendingCardConfirm && pendingCardConfirm.playerId === oldId) {
        pendingCardConfirm.playerId = socket.id;
      }
      // 更新longjuanfengState的userId为新socket.id（在更新existingPlayer.id之前）
      if (longjuanfengState && longjuanfengState.userId === oldId) {
        longjuanfengState.userId = socket.id;
      }
      // 更新kunlunState的playerId为新socket.id（在更新existingPlayer.id之前）
      if (kunlunState && kunlunState.playerId === oldId) {
        kunlunState.playerId = socket.id;
      }
      // 更新sansiState的playerId为新socket.id（在更新existingPlayer.id之前）
      if (sansiState && sansiState.playerId === oldId) {
        sansiState.playerId = socket.id;
      }
      // 更新qiyuState的playerId为新socket.id（在更新existingPlayer.id之前）
      if (qiyuState && qiyuState.playerId === oldId) {
        qiyuState.playerId = socket.id;
      }
      // 更新玩家id为新socket.id
      existingPlayer.id = socket.id;
      existingPlayer.connected = true; // 标记为已连接
      // 从disconnectedPlayers中移除
      delete disconnectedPlayers[oldId];
      // 更新地产所有权到新id
      board.forEach(s => { if (s.owner === oldId) s.owner = socket.id; });
      selectedCharacters[charName] = socket.id;
      io.emit('updatePlayers', players);
      socket.emit('rejoinSuccess', { playerId: socket.id });
      socket.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });

      // 如果所有离线玩家都回归了，关闭所有人的离线面板
      const stillDisconnected = players.filter(p => !p.connected && !p.bankrupt);
      if (stillDisconnected.length === 0) {
        disconnectedPlayers = {}; // 清空disconnectedPlayers
        io.emit('hideDisconnectOverlay');
      }

      // 发送钻石和昆仑进度数据（只发送进度，不发送面板）
      socket.emit('diamondProgressUpdate', { playerId: diamondProgressPlayerId, playerColor: diamondProgressPlayerColor, progress: diamondProgress });
      if (kunlunState) {
        socket.emit('kunlunProgress', { playerId: kunlunState.playerId, progress: kunlunState.progress });
        socket.emit('kunlunArrive', { playerId: kunlunState.playerId, playerName: kunlunState.playerName, playerColor: kunlunState.playerColor, progress: kunlunState.progress });
      }

      // 按优先级恢复面板状态（优先级高的在后面发送，覆盖前面的）
      // 最低优先级：三思面板
      if (sansiState && sansiState.playerId) {
        const sansiPlayer = players.find(p => p.id === sansiState.playerId);
        if (sansiPlayer) {
          socket.emit('sansiStart', { playerId: sansiState.playerId, playerName: sansiPlayer.name, playerColor: sansiPlayer.color, options: sansiState.options });
        }
      }
      // 低优先级：奇遇面板
      if (qiyuState && qiyuState.playerId) {
        const qiyuPlayer = players.find(p => p.id === qiyuState.playerId);
        if (qiyuPlayer) {
          socket.emit('qiyuPanel', { qiyuId: qiyuState.qiyuId, name: qiyuState.name, desc: qiyuState.desc, playerId: qiyuState.playerId, playerName: qiyuPlayer.name, playerColor: qiyuPlayer.color });
        }
      }
      // 中优先级：昆仑面板（仅在进度完成时才发送，进度未完成时不发送）
      if (kunlunState && kunlunState.progress >= 100) {
        const kunlunPlayer = players.find(p => p.id === kunlunState.playerId);
        if (kunlunPlayer) {
          socket.emit('kunlunPanel', { playerId: kunlunState.playerId, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, options: [] });
        }
      }
      // 中高优先级：拍卖状态
      if (auctionState && auctionState.active) {
        socket.emit('auctionStart', { property: auctionState.property, propertyId: auctionState.propertyId, minBid: auctionState.minBid, currentBid: auctionState.currentBid, highestBidder: auctionState.highestBidder });
      }
      // 中高优先级：机遇等待状态
      if (jiyuPendingState) {
        socket.emit('jiyuPending', { playerId: jiyuPendingState.playerId, jiyuId: jiyuPendingState.jiyuId, name: jiyuPendingState.name, desc: jiyuPendingState.desc });
      }
      // 高优先级：保护卡询问状态
      if (baohuQueryState) {
        socket.emit('baohuQuery', { propertyName: baohuQueryState.propertyName, currentPlayerName: baohuQueryState.currentPlayerName, currentPlayerColor: baohuQueryState.currentPlayerColor });
      }
      // 最高优先级：龙卷风卡状态（如果该玩家正在选择目标）
      if (longjuanfengState && longjuanfengState.userId === socket.id && longjuanfengState.phase === 'selectTarget') {
        socket.emit('longjuanfengSelectTarget', { canSelectSelf: true });
        const longjuanfengPlayer = players.find(p => p.id === longjuanfengState.userId);
        if (longjuanfengPlayer) {
          socket.emit('updateAreaE', { message: `${coloredName(longjuanfengPlayer.name, longjuanfengPlayer.color)}使用龙卷风卡，请选择目标` });
        }
      }
      // 最高优先级：卡片确认状态（隐藏卡/免休卡询问）
      if (pendingCardConfirm && pendingCardConfirm.playerId === socket.id) {
        if (pendingCardConfirm.cardsInfo) {
          // 隐藏卡多选确认
          // 发送给目标玩家，显示H区选项
          socket.emit('hiddenCardMultiConfirm', { cards: pendingCardConfirm.cardsInfo, sourceName: pendingCardConfirm.sourceName, sourceColor: pendingCardConfirm.sourceColor, isTarget: true });
          // 同时发送overlay给该玩家（因为是重连，需要恢复overlay状态）
          const targetPlayer = players.find(p => p.id === socket.id);
          if (targetPlayer) {
            socket.emit('hiddenCardOverlay', { targetPlayerId: socket.id, cards: pendingCardConfirm.cardsInfo, targetName: targetPlayer.name, targetColor: targetPlayer.color });
          }
        } else if (pendingCardConfirm.cardName === '免休卡') {
          // 免休卡确认
          socket.emit('cardConfirmPopup', { cardName: '免休卡', image: 'mianxiu', description: '免休卡：免除休息1次', reason: pendingCardConfirm.reason, isTarget: true });
          // 同时发送overlay给该玩家（因为是重连，需要恢复overlay状态）
          socket.emit('cardConfirmOverlay', { targetPlayerId: socket.id, cardName: '免休卡', cardImage: 'mianxiu', targetName: existingPlayer.name, targetColor: existingPlayer.color });
        } else {
          // 其他卡片确认
          const card = cardData.find(c => c.name === pendingCardConfirm.cardName);
          socket.emit('cardConfirmPopup', { cardName: pendingCardConfirm.cardName, image: card?.image || 'card', description: card?.description || '', reason: pendingCardConfirm.reason });
        }
        // 恢复E区消息
        if (pendingCardConfirm.sourceName) {
          socket.emit('updateAreaE', { message: `${coloredName(pendingCardConfirm.sourceName, pendingCardConfirm.sourceColor)}选择了你作为目标，是否使用隐藏卡？` });
        }
      } else if (pendingCardConfirm && pendingCardConfirm.cardName) {
        // 如果pendingCardConfirm存在但不是当前玩家，也发送overlay（其他玩家看到覆盖）
        const targetPlayer = players.find(p => p.id === pendingCardConfirm.playerId);
        if (targetPlayer) {
          const card = cardData.find(c => c.name === pendingCardConfirm.cardName);
          socket.emit('cardConfirmOverlay', { targetPlayerId: pendingCardConfirm.playerId, cardName: pendingCardConfirm.cardName, cardImage: card?.image || 'mianxiu', targetName: targetPlayer.name, targetColor: targetPlayer.color });
        }
      }

      // 发送当前回合玩家的状态（用于E区恢复）
      const current = players[currentPlayerIndex];
      if (current && !current.inJail && gameState === 'playing') {
        // 如果没有任何激活的面板，才显示默认消息
        if (!pendingCardConfirm && !longjuanfengState && !sansiState && !qiyuState && !kunlunState && !auctionState && !jiyuPendingState && !baohuQueryState) {
          socket.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}正在思考...` });
        }
      }

      // 发送F区状态（如果是当前玩家的回合且已掷骰）
      if (current && current.id === socket.id && gameState === 'playing' && diceRolled && !current.inJail) {
        // 已掷骰，发送结束按钮
        socket.emit('showEndTurn');
      }
      return;
    }

    if (players.length >= 6) return socket.emit('error', '最多6名玩家');

    // 游戏进行中不允许新玩家加入（只有已存在的玩家可以重连）
    if (gameState === 'playing') {
      socket.emit('joinRejected', { reason: '游戏正在进行中' });
      socket.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      return;
    }

    const player = {
      id: socket.id,
      name: name.trim() || `玩家${players.length + 1}`,
      character: charColor,
      variant: charVariant,
      position: 6,
      money: 0,
      salary: 10,
      frozen: 0,
      fengdiTurns: 0,
      inJail: false,
      jailState: null,
      restTurns: 0,
      bankrupt: false,
      hasDiamond: false,
      color: charColors[charColor],
      hezongState: null,
      hezongTurns: 0,
      hezongTarget: null,
      diceEffects: [],
      connected: true // 标记为已连接
    };
    players.push(player);
    selectedCharacters[charName] = socket.id;
    io.emit('updatePlayers', players);
    io.emit('syncCharacters', selectedCharacters);
  });

  socket.on('removePlayer', ({ playerId }) => {
    if (gameState !== 'waiting') return;
    const idx = players.findIndex(p => p.id === playerId);
    if (idx === -1) return;
    const removed = players.splice(idx, 1)[0];
    // 清除selectedCharacters中该玩家的记录
    const charKey = removed.character + (removed.variant || '');
    delete selectedCharacters[charKey];
    // 通知被移除的玩家
    io.to(playerId).emit('playerRemoved');
    io.emit('updatePlayers', players);
    io.emit('syncCharacters', selectedCharacters);
  });

  socket.on('updateName', (name) => {
    const player = players.find(p => p.id === socket.id);
    if (player) {
      player.name = name.trim() || player.name;
      io.emit('updatePlayers', players);
    }
  });

  socket.on('quickStart', () => {
    if (gameState !== 'waiting') return;

    const allSockets = [];
    io.sockets.sockets.forEach(s => {
      // 只检查是否已经在players中，移除activeInLobby检查
      if (!players.find(p => p.id === s.id)) {
        allSockets.push(s);
      }
    });
    
    const shuffledColors = [...characters].sort(() => Math.random() - 0.5);
    const shuffledSurnames = [...mzSurnames].sort(() => Math.random() - 0.5);
    const shuffledGivenNames = [...mzGivenNames].sort(() => Math.random() - 0.5);
    
    allSockets.forEach((s, i) => {
      if (i >= shuffledColors.length) return;
      const char = shuffledColors[i];
      const variant = String(Math.floor(Math.random() * 15) + 1);
      const charName = char + variant;
      const surname = shuffledSurnames[i % shuffledSurnames.length];
      const givenName = shuffledGivenNames[i % shuffledGivenNames.length];
      const name = surname + givenName;
      const player = {
        id: s.id,
        name,
        character: char,
        variant,
        position: 0, // 设置初始位置为起点
        money: 0,
        salary: 10,
        frozen: 0,
        fengdiTurns: 0,
        inJail: false,
        jailState: null,
        restTurns: 0,
        bankrupt: false,
        hasDiamond: false,
        color: charColors[char],
        hezongState: null,
        hezongTurns: 0,
        hezongTarget: null,
        diceEffects: [],
        connected: true // 标记为已连接
      };
      players.push(player);
      selectedCharacters[charName] = s.id;
      s.emit('quickStartPlayer', { name, character: char, variant });
    });
    
    io.emit('updatePlayers', players);
    io.emit('syncCharacters', selectedCharacters);
    
    if (players.length >= 2) {
      const count = players.length;
      const money = moneyTable[count] || 150;
      players.forEach((p, idx) => {
        p.money = money;
        p.position = idx < 2 ? 0 : idx < 4 ? 12 : 24;
        if (!p.petPlaceholder) p.petPlaceholder = Math.floor(Math.random() * 6) + 1;
        if (!p.cards) p.cards = [];
      });
      gameState = 'playing';
      currentPlayerIndex = 0;
      roundCounter = 1;
      startGameVotes.clear();
      io.emit('gameStarted', { players, board, currentPlayerIndex, roundCounter });
    }
  });

  socket.on('startGame', () => {
    if (players.length < 1 || gameState !== 'waiting') return;
    
    const activePlayers = players.filter(p => !p.bankrupt);
    const count = activePlayers.length;
    const money = moneyTable[count] || 150;
    players.forEach((p, idx) => {
      p.money = money;
      p.position = idx < 2 ? 0 : idx < 4 ? 12 : 24;
      p.petPlaceholder = Math.floor(Math.random() * 6) + 1;
      if (!p.cards) p.cards = [];
    });
    gameState = 'playing';
    currentPlayerIndex = 0;
    roundCounter = 1;
    startGameVotes.clear();
    io.emit('gameStarted', { players, board, currentPlayerIndex, roundCounter });
  });

  // 发放卡片：给每个玩家分发初始的8张卡（保护卡-净化卡）
  socket.on('testCards', () => {
    if (gameState !== 'playing') return;
    const excludedIds = [1, 2, 3, 7, 8, 9, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 26, 27, 28, 29, 31, 32, 33, 34, 61, 62, 63];
    players.forEach(p => {
      if (p.bankrupt) return;
      if (!p.cards) p.cards = [];
      cardData.forEach(card => {
        if (!excludedIds.includes(card.id) && card.id !== 6) {
          addCardToPlayer(p, card);
        }
      });
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: '发放卡片：已给每个玩家分发8张卡' });
  });

  // 测试机遇：依次测试调虎离山和远交近攻
  let testJiyuIndex = 0;
  const testJiyuList = [
    { id: 79, name: '调虎离山', desc: '可拼钱并获得对方的钱，输到海南', weight: 1 },
    { id: 81, name: '远交近攻', desc: '可拼钱，你的钱交给第三人，输给赢10', weight: 1 },
    { id: 82, name: '封地', desc: '令他人不能买地/建房，持续3回合', weight: 2 }
  ];
  socket.on('testJiyu', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.bankrupt) return;
    const fengdiCard = { id: 82, name: '封地', desc: '令他人不能买地/建房，持续3回合', weight: 2 };
    const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
    if (validTargets.length === 0) {
      io.emit('qiyuNoEffect', { message: `封地：没有合适的目标`, playerId: current.id });
      return;
    }
    qiyuState = {
      playerId: current.id,
      playerName: current.name,
      playerColor: current.color,
      qiyu: fengdiCard
    };
    socket.emit('jiyuShowGif');
    socket.emit('jiyuCardShowWithOption', { name: '封地', desc: fengdiCard.desc, playerId: current.id, options: ['封地', '结束'] });
  });

  socket.on('testQiyu', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.bankrupt) return;
    processQiyu(49, socket);
  });

  socket.on('testGivePet', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.bankrupt) return;
    current.petImage = '22.png';
    current.petFlipped = false;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}获得宠物：影魔` });
  });

  const testSansiOptions = ['上家-4，下家-3', '到起点'];
  socket.on('testFreeze', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.bankrupt) return;
    previewMoney(current.id, -20);
    current.frozen = (current.frozen || 0) + 20;
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}冻结20` });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
  });
  socket.on('testSansi', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.bankrupt) return;
    const shuffled = [...testSansiOptions].sort(() => Math.random() - 0.5);
    const sansiOptions = shuffled.slice(0, 2);
    sansiState = { playerId: current.id, playerName: current.name, playerColor: current.color, options: sansiOptions, phase: 'select', selectedOption: null, remainingOptions: [], targetId: null };
    io.emit('sansiPanel', {
      playerId: current.id,
      playerName: current.name,
      playerColor: current.color,
      options: sansiOptions
    });
  });

  socket.on('jinmenUseKey', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const keyIndex = current.cards ? current.cards.findIndex(c => c.id === 13) : -1;
    if (keyIndex === -1) {
      io.emit('updateAreaE', { message: '没有钥匙' });
      socket.emit('showEndTurn');
      return;
    }
    const doKeyReward = () => {
      if (!current.cards) current.cards = [];
      const allCardIds = [1,2,3,4,5,6,7,8,9,10,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28];
      for (let i = 0; i < 6; i++) {
        const randomId = allCardIds[Math.floor(Math.random() * allCardIds.length)];
        const card = cardData.find(c => c.id === randomId);
        if (card) addCardToPlayer(current, card);
      }
      previewMoney(current.id, 100);
      current.salary = (current.salary || 0) + 40;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}获得6张卡，+100，工资+40` });
      socket.emit('showEndTurn');
    };
    triggerYaoshi(current.id, '金门：获得6张卡，+100，工资+40', '获得6张卡，+100，工资+40', doKeyReward);
  });

  socket.on('flipAllPets', () => {
    if (gameState !== 'playing') return;
    const anyFlipped = players.some(p => !p.bankrupt && p.petImage && p.petFlipped);
    players.forEach(p => {
      if (!p.bankrupt && p.petImage) {
        p.petFlipped = !anyFlipped;
        if (!p.petFlipped) {
          const info = getPetInfo(p.petImage);
          if (info && info.name === '神速蜗牛') {
            p.snailCharges = 2;
          }
          if (info && info.name === '影魔') {
            p.yingmoCharges = 3;
          }
        }
      }
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
  });

  // 恶狼相关
  let pendingWolfState = null;

  function checkWolfAfterRent(payerId, ownerId, socket) {
    const payer = players.find(p => p.id === payerId);
    const owner = players.find(p => p.id === ownerId);
    if (!payer || !owner) { socket.emit('showEndTurn'); return; }
    const ownerPetInfo = getPetInfo(owner.petImage);
    if (ownerPetInfo && ownerPetInfo.name === '恶狼' && !owner.petFlipped) {
      if (payer.wolfMark && payer.wolfMark.ownerId === ownerId) {
        deductMoney(payer.id, 10);
        previewMoney(owner.id, 10);
        io.emit('showTip', { imgSrc: '/drawable/chongwu/chongwu2/cw1.png', text: `${coloredName(payer.name, payer.color)}被${coloredName(owner.name, owner.color)}的恶狼夺走10` });
        delete payer.wolfMark;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        socket.emit('showEndTurn');
        return;
      }
      pendingWolfState = { payerId, ownerId };
      io.emit('wolfOverlay', { ownerName: owner.name, ownerColor: owner.color, payerId });
      socket.emit('wolfChoice', { ownerName: owner.name, ownerColor: owner.color });
      return;
    }
    socket.emit('showEndTurn');
  }

  socket.on('wolfChoiceResponse', (choice) => {
    if (!pendingWolfState) return;
    const { payerId, ownerId } = pendingWolfState;
    pendingWolfState = null;
    const payer = players.find(p => p.id === payerId);
    const owner = players.find(p => p.id === ownerId);
    if (!payer || !owner) return;
    io.emit('wolfOverlayClose');
    if (choice === 'pay4') {
      deductMoney(payer.id, 4);
      previewMoney(owner.id, 4);
      io.emit('updateAreaE', { message: `${coloredName(payer.name, payer.color)}交给${coloredName(owner.name, owner.color)}的恶狼4` });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      socket.emit('showEndTurn');
    } else if (choice === 'mark10') {
      payer.wolfMark = { ownerId: owner.id, ownerName: owner.name };
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      socket.emit('showEndTurn');
    }
  });

  socket.on('activateCicada', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    current.cicadaActive = true;
    current.cicadaCount = 0;
    current.cicadaTotalSteps = 0;
    current.cicadaPosition = current.position;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('cicadaActivated', { playerId: current.id });
  });

  socket.on('activateMammoth', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    if (current.petFlipped) return;
    if (current.inJail) return;
    const petInfo = getPetInfo(current.petImage);
    if (!petInfo || petInfo.name !== '寒冰猛犸') return;
    const currentRow = Math.floor(current.position / 6);
    const sameRowOthers = players.filter(p => !p.bankrupt && p.id !== current.id && Math.floor(p.position / 6) === currentRow);
    if (sameRowOthers.length > 0) {
      sameRowOthers.forEach(p => { p.mammothFrozenBy = current.id; });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的寒冰猛犸冻住了${sameRowOthers.map(p => coloredName(p.name, p.color)).join('、')}` });
    } else {
      current.mammothSelfFrozen = true;
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的寒冰猛犸冻住了自己` });
    }
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
  });

  socket.on('activateHundun', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    if (current.petFlipped) return;
    if (current.inJail) return;
    const petInfo = getPetInfo(current.petImage);
    if (!petInfo || petInfo.name !== '混沌') return;
    const currentRow = Math.floor(current.position / 6);
    const sameRowOthers = players.filter(p => !p.bankrupt && p.id !== current.id && Math.floor(p.position / 6) === currentRow);
    const noZaieTargets = sameRowOthers.filter(p => !p.zaie || p.zaie <= 0);
    if (noZaieTargets.length > 0) {
      noZaieTargets.forEach(p => { p.zaie = 3; });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的混沌对${noZaieTargets.map(p => coloredName(p.name, p.color)).join('、')}施加灾厄3回合` });
    } else {
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的混沌没有目标，无事发生` });
    }
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
  });

  socket.on('activateSnail', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    if (current.petFlipped) return;
    const petInfo = getPetInfo(current.petImage);
    if (!petInfo || petInfo.name !== '神速蜗牛') return;
    if (current.snailCharges === undefined) current.snailCharges = 2;
    if (current.snailCharges <= 0) return;
    players.forEach(p => { if (!p.bankrupt) p.snailStatus = true; });
    current.snailCharges--;
    if (current.snailCharges <= 0) {
      current.petFlipped = true;
    }
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的神速蜗牛令所有人下回合只能掷小点` });
  });

  socket.on('activateLiebao', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    if (current.petFlipped) return;
    const petInfo = getPetInfo(current.petImage);
    if (!petInfo || petInfo.name !== '猎豹') return;
    current.liebao = true;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
  });

  socket.on('activateHanxueMa', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    if (current.petFlipped) return;
    const petInfo = getPetInfo(current.petImage);
    if (!petInfo || petInfo.name !== '汗血马') return;
    current.hanxueMa = true;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
  });

  socket.on('activateBaizuchong', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    if (current.petFlipped) return;
    const petInfo = getPetInfo(current.petImage);
    if (!petInfo || petInfo.name !== '百足虫') return;
    if (!current.baizuchongUsed) current.baizuchongUsed = [];
    if (current.baizuchongCycleComplete) {
      current.baizuchongUsed = [];
      current.baizuchongCycleComplete = false;
    }
    const allOptions = ['zhi1', 'zhixiaodian', 'dianshu1', 'zaidong'];
    const remaining = allOptions.filter(o => !current.baizuchongUsed.includes(o));
    socket.emit('baizuchongOptions', { options: remaining });
  });

  socket.on('activateXibao', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    if (current.petFlipped) return;
    const petInfo = getPetInfo(current.petImage);
    if (!petInfo || petInfo.name !== '细胞') return;
    if (petPool.length < 2) {
      io.emit('updateAreaE', { message: '宠物库不足' });
      return;
    }
    zhongjinState = { playerId: current.id, free: true };
    const shuffled = [...petPool].sort(() => Math.random() - 0.5);
    const selectedPets = shuffled.slice(0, 2);
    const petsWithInfo = selectedPets.map(petImage => {
      const petInfo = getPetInfo(petImage);
      return {
        image: petImage,
        name: petInfo ? petInfo.name : '宠物',
        desc: petInfo ? petInfo.desc : ''
      };
    });
    socket.emit('zhongjinShowPets', { pets: petsWithInfo });
  });

  socket.on('activateZheRenFeng', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    if (current.petFlipped) return;
    const petInfo = getPetInfo(current.petImage);
    if (!petInfo || petInfo.name !== '蜇人蜂') return;
    const targetProperties = board.filter(s => s.type === 'property' && s.isProperty && s.owner && s.owner !== current.id && !s.closed);
    if (targetProperties.length === 0) {
      io.emit('updateAreaE', { message: '没有合适的可选中地产' });
      return;
    }
    const propsData = targetProperties.map(s => ({ id: s.id, name: s.name }));
    socket.emit('zheRenFengSelectProperty', { properties: propsData });
  });

  socket.on('zheRenFengChooseProperty', ({ spaceId }) => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    const space = board.find(s => s.id === spaceId);
    if (!space || !space.owner || space.owner === current.id || space.closed) return;
    const owner = players.find(p => p.id === space.owner);
    if (!owner) return;
    // 检查保护卡
    if (owner.cards && owner.cards.some(c => c.name === '保护卡')) {
      baohuQueryState = {
        propertyId: spaceId,
        ownerId: owner.id,
        currentPlayerId: current.id,
        source: 'zheRenFeng'
      };
      zheRenFengState = { payerId: current.id, ownerId: owner.id, spaceId, spaceName: space.name, rent: 4 };
      const ownerSocket = io.sockets.sockets.get(owner.id);
      if (ownerSocket) {
        ownerSocket.emit('baohuQuery', { propertyName: space.name, currentPlayerName: current.name, currentPlayerColor: current.color });
      }
      io.emit('baohuOverlay', { targetPlayerId: owner.id, targetName: owner.name, targetColor: owner.color });
      io.emit('updateAreaE', { message: `等待${coloredName(owner.name, owner.color)}决定是否使用保护卡` });
      return;
    }
    doZheRenFengPay(current, owner, space, socket);
  });

  socket.on('zheRenFengOwnerResponse', ({ choice }) => {
    if (!zheRenFengState) return;
    const state = zheRenFengState;
    if (socket.id !== state.ownerId) return;
    const owner = players.find(p => p.id === state.ownerId);
    const space = board.find(s => s.id === state.spaceId);
    if (!owner || !space) { zheRenFengState = null; return; }
    if (choice === 'pay10') {
      deductMoney(owner.id, 10);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      if (checkBankruptcy(owner)) { zheRenFengState = null; nextTurn(); return; }
      io.emit('updateAreaE', { message: `地主${coloredName(owner.name, owner.color)}-10` });
    } else if (choice === 'close') {
      space.closed = true;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `地主${coloredName(owner.name, owner.color)}的${space.name}停业` });
    }
    const ownerSocket = io.sockets.sockets.get(state.ownerId);
    if (ownerSocket) ownerSocket.emit('zheRenFengClearF');
    zheRenFengState = null;
  });

  socket.on('activateYingMo', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    if (current.petFlipped) return;
    const petInfo = getPetInfo(current.petImage);
    if (!petInfo || petInfo.name !== '影魔') return;
    if (current.yingmoCharges === undefined) current.yingmoCharges = 3;
    if (current.yingmoCharges <= 0) return;
    if (yingmoPosition === null) {
      yingmoPosition = current.position;
      io.emit('yingmoPositionUpdate', { position: yingmoPosition, jailed: false });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    }
    io.emit('updateAreaE', { message: '请选择目标与影魔互换位置' });
    socket.emit('yingmoSelectTarget');
  });

  socket.on('yingmoChooseTarget', ({ targetId }) => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    if (yingmoPosition === null) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;
    const targetName = coloredName(target.name, target.color);
    const tempPos = target.position;
    target.position = yingmoPosition;
    yingmoPosition = tempPos;
    let jailed = false;
    const JAIL_POSITIONS = [JAIL_ISLAND_ID, JAIL_HOSPITAL_ID, JAIL_JAIL_ID, JAIL_FREE_ID];
    const POS_TO_JAILSTATE = { [JAIL_ISLAND_ID]: 'island', [JAIL_HOSPITAL_ID]: 'hospital', [JAIL_JAIL_ID]: 'jail', [JAIL_FREE_ID]: 'health' };
    if (target.inJail && !JAIL_POSITIONS.includes(target.position)) {
      target.inJail = false;
      target.jailState = null;
    }
    if (!target.inJail && JAIL_POSITIONS.includes(target.position)) {
      target.inJail = true;
      jailed = true;
    }
    if (target.inJail && JAIL_POSITIONS.includes(target.position)) {
      jailed = true;
    }
    if (target.inJail && POS_TO_JAILSTATE[target.position]) {
      target.jailState = POS_TO_JAILSTATE[target.position];
    }
    current.yingmoCharges = (current.yingmoCharges || 3) - 1;
    if (current.yingmoCharges <= 0) {
      current.petFlipped = true;
      yingmoPosition = null;
    }
    io.emit('yingmoPositionUpdate', { position: yingmoPosition, jailed });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${targetName}与影魔互换位置` });
  });

  socket.on('baizuchongSelect', ({ option }) => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    if (!current.baizuchongUsed) current.baizuchongUsed = [];
    if (current.baizuchongUsed.includes(option)) return;
    current.baizuchongUsed.push(option);
    const allOptions = ['zhi1', 'zhixiaodian', 'dianshu1', 'zaidong'];
    if (current.baizuchongUsed.length >= 4) {
      current.petFlipped = true;
      current.baizuchongUsed = [];
      current.baizuchongCycleComplete = true;
    }
    if (option === 'zaidong') {
      current.extraTurns = (current.extraTurns || 0) + 1;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      socket.emit('baizuchongClearF');
      return;
    }
    let dice;
    if (option === 'zhi1') {
      dice = 1;
    } else if (option === 'zhixiaodian') {
      dice = Math.floor(Math.random() * 3) + 1;
    } else if (option === 'dianshu1') {
      dice = Math.floor(Math.random() * 6) + 2;
    }
    current.baizuchongDice = dice;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('baizuchongDiceReady');
  });

  socket.on('xixuewenChoice', ({ choice, ownerId }) => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    const owner = players.find(p => p.id === ownerId);
    if (!owner) return;
    if (choice === 'give1') {
      previewMoney(current.id, -1);
      previewMoney(owner.id, 1);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}给${coloredName(owner.name, owner.color)}1` });
      const nextOwner = players.find(p => !p.bankrupt && p.petImage && getPetInfo(p.petImage)?.name === '吸血蚊' && !p.petFlipped && p.id !== current.id && p.id !== owner.id);
      if (nextOwner) {
        const currentSocket = io.sockets.sockets.get(current.id);
        if (currentSocket) {
          currentSocket.emit('xixuewenTck', {
            ownerId: nextOwner.id,
            ownerName: nextOwner.name,
            ownerColor: nextOwner.color
          });
          return;
        }
      }
      // 关闭B区覆盖
      io.emit('xixuewenOverlayClose');
      io.emit('turnUpdate', { players, board, currentPlayerIndex, currentDiceValue, roundCounter });
      const currentSocket = io.sockets.sockets.get(current.id);
      if (current?.cicadaActive && current.cicadaCount < 3 && currentSocket) {
        currentSocket.emit('cicadaTurnStart');
      }
      return;
    }
    if (choice === 'judge') {
      previewMoney(current.id, -4);
      const roll = Math.floor(Math.random() * 6) + 1;
      if (roll <= 2) {
        owner.petFlipped = true;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}-4，判定${roll}，${coloredName(owner.name, owner.color)}吸血蚊翻面` });
      } else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}-4，判定${roll}，吸血蚊还在吸血` });
      }
    } else if (choice === 'give4flip') {
      previewMoney(current.id, -6);
      previewMoney(owner.id, 6);
      owner.petFlipped = true;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}给${coloredName(owner.name, owner.color)}6令吸血蚊翻面` });
    }
    // 检查是否还有其他吸血蚊（排除刚处理的owner）
    const nextOwner = players.find(p => !p.bankrupt && p.petImage && getPetInfo(p.petImage)?.name === '吸血蚊' && !p.petFlipped && p.id !== current.id && p.id !== owner.id);
    if (nextOwner) {
      const currentSocket = io.sockets.sockets.get(current.id);
      if (currentSocket) {
        currentSocket.emit('xixuewenTck', {
          ownerId: nextOwner.id,
          ownerName: nextOwner.name,
          ownerColor: nextOwner.color
        });
        return;
      }
    }
    // 关闭B区覆盖
    io.emit('xixuewenOverlayClose');
    io.emit('turnUpdate', { players, board, currentPlayerIndex, currentDiceValue, roundCounter });
    const currentSocket = io.sockets.sockets.get(current.id);
    if (current?.cicadaActive && current.cicadaCount < 3 && currentSocket) {
      currentSocket.emit('cicadaTurnStart');
    }
  });

  socket.on('hepingxiongmaoResponse', ({ use, propertyName, propertyOwnerId }) => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    const petInfo = getPetInfo(current.petImage);
    if (!petInfo || petInfo.name !== '和平熊猫') return;

    const space = board[current.position];
    if (!space || !space.isProperty || space.houseLevel > 0 || space.owner !== propertyOwnerId) {
      io.emit('bAreaOverlayClose');
      socket.emit('showEndTurn');
      return;
    }
    const owner = players.find(p => p.id === propertyOwnerId);
    if (!owner) { io.emit('bAreaOverlayClose'); socket.emit('showEndTurn'); return; }

    if (use) {
      // 和平熊猫交给地主
      owner.petImage = current.petImage;
      owner.petFlipped = false;
      current.petImage = null;

      // 地产给当前玩家
      space.owner = current.id;

      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}用和平熊猫与${coloredName(owner.name, owner.color)}交换了${space.name}` });
      io.emit('bAreaOverlayClose');
      socket.emit('showEndTurn');
    } else {
      io.emit('bAreaOverlayClose');
      checkWolfAfterRent(current.id, propertyOwnerId, socket);
    }
  });

  socket.on('activateSloth', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt || current.inJail) return;
    if (diceRolled) return;
    const petInfo = getPetInfo(current.petImage);
    if (!petInfo || petInfo.name !== '睡眠树懒') return;
    current.slothActive = true;
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}激活睡眠树懒，本回合掷5-6改为休息1回合并+5` });
  });

  socket.on('activateMeihouwang', () => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    if (current.petFlipped) return;
    const petInfo = getPetInfo(current.petImage);
    if (!petInfo || petInfo.name !== '美猴王') return;

    // 宠物翻面，初始化猴王状态
    current.petFlipped = true;
    meihouwangState = {
      playerId: current.id,
      position: current.position, // 猴王初始位置在玩家位置
      remainingTurns: current.meihouwangRemaining || 4,
      activated: true
    };

    // 发送猴王召唤事件给客户端
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
    io.emit('meihouwangSummoned', { playerId: current.id, position: current.position, remainingTurns: meihouwangState.remainingTurns });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}召唤了猴王！` });
  });

  socket.on('meihouwangSelect', ({ choice }) => {
    if (gameState !== 'playing') return;
    if (!meihouwangState || !meihouwangState.pendingChoice) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;

    meihouwangState.pendingChoice = false;

    // 根据选择确定目标位置
    const playerPosition = meihouwangState.playerPosition;
    const houwangPosition = meihouwangState.houwangPosition;
    const targetPosition = choice === 'player' ? playerPosition : houwangPosition;

    // 减少剩余回合数
    meihouwangState.remainingTurns--;

    // 清除F区
    socket.emit('clearAreaF');

    // 触发目标位置的格子效果（主体始终为当前玩家）
    const space = board[targetPosition];
    
    if (space && space.type === 'property' && space.isProperty && space.owner && space.owner !== current.id) {
      const owner = players.find(p => p.id === space.owner);
      if (owner && !owner.bankrupt && !space.closed) {
        const rent = getRent(space);
        previewMoney(current.id, -rent);
        previewMoney(owner.id, rent);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}` });
        checkWolfAfterRent(current.id, owner.id, socket);
        socket.emit('showEndTurn');
      } else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
        socket.emit('showEndTurn');
      }
    } else if (space && space.type === 'property' && space.isProperty && !space.owner) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
      if (current.fengdiTurns > 0) {
        io.emit('updateAreaE', { message: '封地禁令，无法购买地产/建房' });
        socket.emit('showEndTurn');
      } else {
        socket.emit('canBuy', { space, dice: currentDiceValue });
      }
    } else if (space && space.type === 'property' && space.isProperty && space.owner === current.id) {
      if (current.fengdiTurns > 0) {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
        io.emit('updateAreaE', { message: '封地禁令，无法购买地产/建房' });
        socket.emit('showEndTurn');
      } else if (space.name === '机场') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
        socket.emit('airportChoice', { 
          spaceName: space.displayName || space.name,
          houseLevel: space.houseLevel,
          buildCost: Math.round(space.price / 4),
          airportType: space.airportType || null,
          spaceId: space.id
        });
      } else {
        const excludedProperties = ['台湾'];
        if (!excludedProperties.includes(space.name)) {
          if (space.houseLevel < 4) {
            const buildCost = Math.round(space.price / 4);
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
            socket.emit('buildChoice', { spaceName: space.name, buildCost, houseLevel: space.houseLevel });
          } else {
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
            io.emit('updateAreaE', { message: `${space.name}已经满级` });
            socket.emit('showEndTurn');
          }
        } else {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
          socket.emit('showEndTurn');
        }
      }
    } else if (space && space.type === 'chance') {
      const selectedJiyu = weightedRandomJiyu();
      socket.emit('jiyuShowGif');
      jiyuPendingState = {
        playerId: current.id,
        jiyu: selectedJiyu
      };
      const hasDuogongneng = current.cards && current.cards.some(c => c.name === '多功能卡');
      const hasKoi = hasKoiPet(current);
      socket.emit('jiyuCardShow', { name: selectedJiyu.name, desc: selectedJiyu.desc, hasDuogongneng, hasKoi });
      io.emit('updateAreaE', { message: '是否重新抽机遇？' });
      if (hasKoi || hasDuogongneng) {
        const oimgs = [];
        if (hasKoi) oimgs.push('/drawable/chongwu/8.png');
        if (hasDuogongneng) oimgs.push('/drawable/kapian/duogongneng.png');
        io.emit('koiDuogongnengOverlay', { imgs: oimgs, targetPlayerId: current.id });
      }
    } else if (space && space.type === 'start') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
      io.emit('updateAreaE', { message: '请选择奖励' });
      socket.emit('startChoice');
    } else if (space && space.type === 'jail') {
      if (checkMianxiu(current.id, '进监狱区域')) {
        return;
      }
      if (current.hasDiamond) {
        returnDiamondIfHeld(current);
        io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
      }
      const msg = `${coloredName(current.name, current.color)}巨额财产来源不明罪，进医院`;
      io.emit('updateAreaE', { message: msg });
      setPlayerState(current, 'inJail', true);
      if (current.inJail) {
        current.jailState = 'justJailed';
        current.position = JAIL_JAIL_ID;
        io.emit('showJailMap', { players, board, currentPlayerIndex, message: msg, currentDiceValue });
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
      socket.emit('showEndTurn');
    } else if (space && space.type === 'diamond') {
      if (current.hasDiamond) {
        if (diamondProgressPlayerId === current.id) {
          diamondProgress += 2;
          if (diamondProgress >= 11) {
            current.hasDiamond = false;
            diamondHolder = null;
            diamondProgress = 0;
            diamondProgressPlayerId = null;
            diamondProgressPlayerColor = null;
            previewMoney(current.id, 20);
            current.salary += 3;
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
            io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
            io.emit('diamondRedeemed', { playerName: current.name, playerColor: current.color });
            socket.emit('showEndTurn');
          } else {
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
            io.emit('diamondProgressUpdate', { playerId: current.id, playerColor: current.color, progress: diamondProgress });
            io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}已经获得钻石，进度+2`, currentDiceValue });
            socket.emit('showEndTurn');
          }
        } else {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
          io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}已获得钻石`, currentDiceValue });
          socket.emit('showEndTurn');
        }
      } else if (diamondHolder === true || diamondHolder === null) {
        current.hasDiamond = true;
        diamondHolder = current.id;
        diamondProgress = 0;
        diamondProgressPlayerId = current.id;
        diamondProgressPlayerColor = current.color;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
        io.emit('diamondProgressUpdate', { playerId: current.id, playerColor: current.color, progress: 0 });
        io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}获得钻石`, currentDiceValue });
        socket.emit('showEndTurn');
      } else {
        const holder = players.find(p => p.id === diamondHolder);
        if (holder) {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
          io.emit('updateAreaE', { message: `是否抢夺钻石？与${coloredName(holder.name, holder.color)}拼钱` });
          socket.emit('diamondRob', { holderId: holder.id, holderName: holder.name, holderColor: holder.color, holderMoney: holder.money, robberMoney: current.money });
        }
      }
    } else if (space && space.type === 'pinqian') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
      socket.emit('pinqianSelect');
      return;
    } else if (space && space.type === 'changjiang') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
      if (space.name === '黄河') {
        socket.emit('huangheChoice');
      } else {
        socket.emit('changjiangChoice');
      }
    } else if (space && space.type === 'gaitu') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
      if (space.name === '改土') {
        socket.emit('gaituChoice');
      } else {
        executeGaituEffect(socket, current, space.name);
      }
    } else if (space && space.type === 'hezong') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
      const hezongSpace = board.find(s => s.type === 'hezong');
      const hezongPos = hezongSpace ? hezongSpace.id : 30;
      const hezongPlayers = players.filter(p => p.id !== current.id && p.position === hezongPos && (p.hezongState === 'forced' || p.hezongState === 'normal'));
      if (hezongPlayers.length > 0) {
        const hezongPlayer = hezongPlayers[0];
        socket.emit('hezongIncoming', { hezongPlayerId: hezongPlayer.id, hezongPlayerName: hezongPlayer.name });
      } else {
        socket.emit('hezongChoice');
      }
    } else if (space && space.type === 'siheyuan') {
      const suits = ['hongtao', 'meihua', 'fangkuai', 'heitao'];
      const suitSymbols = { hongtao: '♥', meihua: '♣', fangkuai: '♦', heitao: '♠' };
      const deck = [];
      for (let i = 0; i < 52; i++) {
        deck.push(suits[i % 4]);
      }
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      const drawn = deck.slice(0, 8);
      const row2Suits = drawn.slice(0, 4);
      const row3Suits = drawn.slice(4, 8);
      const allRevealedSuits = new Set(row2Suits);
      const missingInit = suits.filter(s => !allRevealedSuits.has(s));
      const isTianhu = missingInit.length === 0;
      siheyuanState = {
        playerId: current.id,
        playerName: current.name,
        playerColor: current.color,
        row2Suits,
        row3Suits,
        revealed: [false, false, false, false],
        allRevealedSuits: new Set(row2Suits),
        isTianhu
      };
      if (isTianhu) {
        previewMoney(current.id, 10);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}天胡，+10` });
        socket.emit('siheyuanStart', { row2Suits, row3Suits, isTianhu, playerName: current.name, playerColor: current.color, missingSuits: [] });
        io.emit('siheyuanWatch', { row2Suits, row3Suits, revealed: [false, false, false, false], playerName: current.name, playerColor: current.color, playerId: current.id });
      } else {
        previewMoney(current.id, -3);
        const missingSymbols = missingInit.map(s => suitSymbols[s]).join('');
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
        io.emit('updateAreaE', { message: `强制门票3，$3翻开1张卡，还差${missingSymbols}` });
        socket.emit('siheyuanStart', { row2Suits, row3Suits, isTianhu: false, playerName: current.name, playerColor: current.color, missingSuits: missingInit });
        io.emit('siheyuanWatch', { row2Suits, row3Suits, revealed: [false, false, false, false], playerName: current.name, playerColor: current.color, playerId: current.id });
      }
    } else if (space && space.type === 'auction') {
      const excludedCardIds = [0, 5, 13, 15, 21, 24, 26, 61, 62, 63, 64, 65];
      const availableCards = cardData.filter(c => !excludedCardIds.includes(c.id));
      const auctionCard1 = availableCards[Math.floor(Math.random() * availableCards.length)];
      const auctionCard2 = availableCards[Math.floor(Math.random() * availableCards.length)];
      const getDisplayCard = (card) => {
        if (card.id === 6 || card.name === '隐藏卡') {
          return { id: 6, name: '隐藏卡', description: '隐藏卡：成为目标时触发，效果仅卡主可见', image: 'yincang' };
        }
        return card;
      };
      const displayCard1 = getDisplayCard(auctionCard1);
      const displayCard2 = getDisplayCard(auctionCard2);
      const activePlayers = players.filter(p => !p.bankrupt);
      auctionState = {
        card1: auctionCard1,
        card2: auctionCard2,
        bids: {},
        passedPlayers: [],
        currentBidderIndex: activePlayers.findIndex(p => p.id === current.id),
        activePlayers: activePlayers.map(p => p.id),
        currentBid: 0,
        lastBidderId: null
      };
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
      io.emit('auctionStart', {
        card1: displayCard1,
        card2: displayCard2,
        currentBidderId: current.id,
        currentBidderName: current.name,
        currentBidderColor: current.color
      });
    } else if (space && space.type === 'kunlun') {
      if (kunlunState && kunlunState.playerId === current.id) {
        kunlunFromTurn = true;
        kunlunState.progress = 0;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState, kunlunState });
        io.emit('kunlunArrive', { playerId: current.id, playerName: current.name, playerColor: current.color, progress: 0 });
        triggerKunlunPanel(current);
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}收到了仙人的礼物` });
      } else {
        kunlunState = {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          progress: 0
        };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState, kunlunState });
        io.emit('kunlunArrive', { playerId: current.id, playerName: current.name, playerColor: current.color, progress: 0 });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}被仙人赐福` });
        socket.emit('showEndTurn');
      }
    } else if (space && space.type === 'pet') {
      const randomDw = Math.floor(Math.random() * 9) + 1;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
      io.emit('updateAreaE', { message: '请选择一项进行拍卖' });
      socket.emit('petShopPanel', { playerId: current.id, gifIndex: randomDw });
    } else if (space && space.name === '三思') {
      let sansiOptions = [...allSansiOptions];
      const shuffled = sansiOptions.sort(() => Math.random() - 0.5);
      sansiOptions = shuffled.slice(0, 3);
      sansiState = { playerId: current.id, playerName: current.name, playerColor: current.color, options: sansiOptions, phase: 'select', selectedOption: null, remainingOptions: [], targetId: null };
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
      io.emit('sansiPanel', {
        playerId: current.id,
        playerName: current.name,
        playerColor: current.color,
        options: sansiOptions
      });
    } else {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}进入了${space ? space.name : '未知区域'}` });
      socket.emit('showEndTurn');
    }

    // 如果是最后一次，清除猴王状态
    if (meihouwangState && meihouwangState.remainingTurns <= 0) {
      io.emit('meihouwangDisappear', { playerId: current.id });
      meihouwangState = null;
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的猴王消失了` });
    }
  });

  socket.on('cicadaAnimDone', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (current.cicadaReady) {
      current.cicadaReady = false;
      const oldPos = current.position;
      current.position = current.cicadaPosition;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('cicadaPlayerMove', { playerId: current.id, fromPos: oldPos, toPos: current.cicadaPosition });
    } else if (current.cicadaActive && current.cicadaCount < 3) {
      socket.emit('showEndTurn');
    }
  });

  socket.on('playerMoveDone', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    current.cicadaActive = false;
    current.cicadaCount = 0;
    current.cicadaTotalSteps = 0;
    delete current.cicadaPosition;
    delete current.cicadaReady;
    current.cicadaSkillCooldown = 2;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('showEndTurn');
  });

  // 发放地产：给每个玩家随机分发3处地产（1个满级、1个1房、1个空地）
  socket.on('distributeProperties', () => {
    if (gameState !== 'playing') return;

    // 获取所有无主的地产
    const availableProps = board.filter(s => s.isProperty && !s.owner);
    if (availableProps.length < players.filter(p => !p.bankrupt).length * 3) {
      io.emit('updateAreaE', { message: '发放地产：无主地产不足，无法分发' });
      return;
    }

    // 随机打乱地产
    const shuffledProps = availableProps.sort(() => Math.random() - 0.5);

    // 给每个玩家分发3处地产
    let propIndex = 0;
    players.forEach(p => {
      if (p.bankrupt) return;

      // 分发3处地产
      for (let i = 0; i < 3 && propIndex < shuffledProps.length; i++) {
        const prop = shuffledProps[propIndex++];
        prop.owner = p.id;

        // 设置房屋等级：1个满级、1个1房、1个空地
        if (i === 0) prop.houseLevel = 4;  // 满级
        else if (i === 1) prop.houseLevel = 1;  // 1房
        else prop.houseLevel = 0;  // 空地
      }
    });

    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: '发放地产：已给每个玩家分发3处地产（1满级、1房、1空地）' });
  });

  socket.on('rollDice', (dice) => {
    if (gameState !== 'playing') {
      return;
    }
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) {
      return;
    }
    if (current.inJail) {
      return;
    }
    if (diceRolled) {
      return;
    }
    diceRolled = true;

    if (current.hezongState === 'normal') {
      current.hezongState = null;
      current.hezongTurns = 0;
      current.hezongTarget = null;
    }

    const diceRange = playerDiceRange[socket.id];
    // 百足虫预设骰子
    if (current.baizuchongDice) {
      dice = current.baizuchongDice;
      current.baizuchongDice = undefined;
    } else if (current.syncedDice) {
      dice = current.syncedDice;
      current.syncedDice = null;
    } else if (current.guhuoDice) {
      dice = current.guhuoDice;
      current.guhuoDice = null;
      current.guhuoBy = null;
      current.guhuoByColor = null;
    } else if (current.shoumaiDice) {
      dice = current.shoumaiDice;
      current.shoumaiDice = null;
    } else if (current.yinyueDice) {
      dice = current.yinyueDice;
      current.yinyueDice = null;
      current.yinyueBy = null;
      delete playerDiceRange[socket.id];
    } else if (current.tuolei && current.tuolei.turns > 0) {
      dice = Math.floor(Math.random() * 2) + 1;
      current.tuolei.turns--;
      if (current.tuolei.turns <= 0) {
        current.tuolei = null;
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    } else if (current.wenjigifwu) {
      const dice1 = Math.floor(Math.random() * 6) + 1;
      const dice2 = Math.floor(Math.random() * 6) + 1;
      dice = dice1 + dice2;
      current.wenjigifwu = false;
      currentDiceValue = dice;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('wenjigifwuDice', { playerId: current.id, dice1, dice2, total: dice });
    } else if (current.liebao) {
      const dice1 = Math.floor(Math.random() * 6) + 1;
      const dice2 = Math.floor(Math.random() * 6) + 1;
      dice = dice1 + dice2;
      current.liebao = false;
      currentDiceValue = dice;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('liebaoDice', { playerId: current.id, dice1, dice2, total: dice });
    } else if (current.hanxueMa) {
      dice = Math.floor(Math.random() * 5) + 3;
      current.hanxueMa = false;
      currentDiceValue = dice;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    } else if (diceRange) {
      dice = Math.floor(Math.random() * (diceRange.max - diceRange.min + 1)) + diceRange.min;
      delete playerDiceRange[socket.id];
    } else if (current.diceEffects && current.diceEffects.length > 0) {
      const effect = current.diceEffects.shift();
      dice = Math.floor(Math.random() * (effect.max - effect.min + 1)) + effect.min;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    } else {
      // 使用玩家选择的骰子点数（来自G区选择面板）
      if (typeof dice !== 'number' || dice < 0 || dice > 30 || !Number.isInteger(dice)) {
        dice = Math.floor(Math.random() * 6) + 1;
      }
    }

    if (current.fengkongDice && current.fengkongDice.length > 0 && current.fengkongDice.includes(dice)) {
      let attempts = 0;
      while (current.fengkongDice.includes(dice) && attempts < 100) {
        dice = Math.floor(Math.random() * 6) + 1;
        attempts++;
      }
      current.fengkongDice = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    }

    if (current.snailStatus) {
      dice = Math.floor(Math.random() * 3) + 1;
      current.snailStatus = false;
    }

    // 变色龙：掷出6改为自选点数
    if (dice === 6) {
      const petInfo = getPetInfo(current.petImage);
      if (petInfo && petInfo.name === '变色龙' && !current.petFlipped) {
        current.chameleonSelecting = true;
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}掷出6，变色龙改为自选点数` });
        socket.emit('chameleonChooseDice');
        return;
      }
    }

    currentDiceValue = dice;

    // 毒蛇标记：超出点数上限的骰子无效，原地休息
    if (current.snakeReduction && current.snakeReduction > 0) {
      const effectiveCap = 6 - current.snakeReduction;
      if (dice > effectiveCap) {
        current.snakeReduction--;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}中了蛇毒，休息1回合，点数上限+1` });
        socket.emit('showEndTurn');
        return;
      }
    }

    // 睡眠树懒：掷5-6改为休息1回合并+5
    if (current.slothActive) {
      current.slothActive = false;
      if (dice === 5 || dice === 6) {
        previewMoney(current.id, 5);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}掷${dice}，睡眠树懒改为休息1回合并+5` });
        socket.emit('showEndTurn');
        return;
      }
    }

    // 夏蝉技能：前3次骰子由蝉移动，不触发格子效果
    if (current.cicadaActive && current.cicadaCount < 3) {
      current.cicadaCount++;
      current.cicadaTotalSteps += dice;
      const fromPos = current.cicadaPosition;
      current.cicadaPosition = (current.cicadaPosition + dice) % BOARD_SIZE;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('cicadaMove', { playerId: current.id, fromPos, dice, toPos: current.cicadaPosition, count: current.cicadaCount });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的夏蝉移动${dice}步` });
      if (current.cicadaCount === 3) {
        current.cicadaReady = true;
      }
      return;
    }

    // 美猴王技能：棋子和猴王都移动，不触发格子效果
    if (meihouwangState && meihouwangState.playerId === current.id && meihouwangState.activated) {
      const playerFromPos = current.position;
      const houwangFromPos = meihouwangState.position;

      // 棋子按骰子点数移动
      let playerNewPos = (current.position + dice) % BOARD_SIZE;
      current.position = playerNewPos;

      // 猴王随机前进1-6格
      const houwangDice = Math.floor(Math.random() * 6) + 1;
      let houwangNewPos = (meihouwangState.position + houwangDice) % BOARD_SIZE;
      meihouwangState.position = houwangNewPos;

      // 设置待选择状态
      meihouwangState.pendingChoice = true;
      meihouwangState.playerPosition = playerNewPos;
      meihouwangState.houwangPosition = houwangNewPos;

      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, meihouwangState });
      io.emit('meihouwangMove', {
        playerId: current.id,
        playerFromPos,
        playerDice: dice,
        playerToPos: playerNewPos,
        houwangFromPos,
        houwangDice,
        houwangToPos: houwangNewPos
      });

      // 在F区显示选择按钮
      socket.emit('meihouwangChoiceInF', {
        playerPosition: playerNewPos,
        playerSpaceName: board[playerNewPos].name,
        houwangPosition: houwangNewPos,
        houwangSpaceName: board[houwangNewPos].name
      });

      io.emit('updateAreaE', { message: `猴王前进${houwangDice}步，请选择落点` });
      return;
    }

    const isDaotui = !!current.daotui;
    if (isDaotui) {
      current.daotui = false;
    }

    let newPos;
    if (dice === 0) {
      newPos = current.position;
    } else if (isDaotui) {
      newPos = current.position - dice;
      if (newPos < 0) newPos += BOARD_SIZE;
    } else {
      newPos = current.position + dice;
      if (newPos >= BOARD_SIZE) {
        newPos -= BOARD_SIZE;
      }
    }

    const fromPos = current.position;

    if (dice > 0 && !isDaotui) {
      let duanqiaoStop = -1;
      let luzhangStop = -1;
      for (let i = 1; i <= dice; i++) {
        const passPos = (fromPos + i) % BOARD_SIZE;
        const passSpace = board[passPos];
        if (passSpace && passSpace.closed && passSpace.owner === current.id) {
          passSpace.closed = false;
        }
        if (passSpace && passSpace.type === 'start' && i < dice && current.frozen > 0) {
        }
        if (passSpace && passSpace.name === '断桥' && i < dice) {
          duanqiaoStop = passPos;
          break;
        }
        if (luzhangPositions.includes(passPos) && i < dice) {
          luzhangStop = passPos;
          break;
        }
      }
      if (duanqiaoStop >= 0) {
        const steps = (duanqiaoStop - fromPos + BOARD_SIZE) % BOARD_SIZE;
        current.position = duanqiaoStop;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('diceResult', { playerId: current.id, fromPos, dice: steps, newPos: duanqiaoStop });
        diceAnimState = { playerId: current.id, fromPos, dice: steps, newPos: duanqiaoStop, duanqiaoStop: true };
        return;
      }
      if (luzhangStop >= 0) {
        const steps = (luzhangStop - fromPos + BOARD_SIZE) % BOARD_SIZE;
        current.position = luzhangStop;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('diceResult', { playerId: current.id, fromPos, dice: steps, newPos: luzhangStop });
        diceAnimState = { playerId: current.id, fromPos, dice: steps, newPos: luzhangStop, luzhangStop: true };
        return;
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('diceResult', { playerId: current.id, fromPos, dice, newPos });
      const landedOnLuzhang = luzhangPositions.includes(newPos);
      diceAnimState = { playerId: current.id, fromPos, dice, newPos, luzhangStop: landedOnLuzhang };
      return;
    }

    if (dice > 0 && isDaotui) {
      let duanqiaoStop = -1;
      let luzhangStop = -1;
      for (let i = 1; i <= dice; i++) {
        const passPos = (fromPos - i + BOARD_SIZE) % BOARD_SIZE;
        const passSpace = board[passPos];
        if (passSpace && passSpace.name === '断桥' && i < dice) {
          duanqiaoStop = passPos;
          break;
        }
        if (luzhangPositions.includes(passPos) && i < dice) {
          luzhangStop = passPos;
          break;
        }
      }
      if (duanqiaoStop >= 0) {
        const steps = (fromPos - duanqiaoStop + BOARD_SIZE) % BOARD_SIZE;
        current.position = duanqiaoStop;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('diceResult', { playerId: current.id, fromPos, dice: steps, newPos: duanqiaoStop, direction: 'backward' });
        diceAnimState = { playerId: current.id, fromPos, dice: steps, newPos: duanqiaoStop, duanqiaoStop: true, isDaotui };
        return;
      }
      if (luzhangStop >= 0) {
        const steps = (fromPos - luzhangStop + BOARD_SIZE) % BOARD_SIZE;
        current.position = luzhangStop;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('diceResult', { playerId: current.id, fromPos, dice: steps, newPos: luzhangStop, direction: 'backward' });
        diceAnimState = { playerId: current.id, fromPos, dice: steps, newPos: luzhangStop, luzhangStop: true, isDaotui };
        return;
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('diceResult', { playerId: current.id, fromPos, dice, newPos, direction: 'backward' });
      const landedOnLuzhang = luzhangPositions.includes(newPos);
      diceAnimState = { playerId: current.id, fromPos, dice, newPos, isDaotui, luzhangStop: landedOnLuzhang };
      return;
    }

    handleDiceLanding(socket, current, current.position, newPos);
  });

  socket.on('chameleonDiceSelect', ({ diceValue }) => {
    if (gameState !== 'playing') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || current.bankrupt) return;
    if (!current.chameleonSelecting) return;
    current.chameleonSelecting = false;

    const isDaotui = !!current.daotui;
    if (isDaotui) current.daotui = false;
    currentDiceValue = diceValue;

    let newPos;
    if (diceValue === 0) {
      newPos = current.position;
    } else if (isDaotui) {
      newPos = current.position - diceValue;
      if (newPos < 0) newPos += BOARD_SIZE;
    } else {
      newPos = current.position + diceValue;
      if (newPos >= BOARD_SIZE) newPos -= BOARD_SIZE;
    }

    const fromPos = current.position;

    if (diceValue > 0 && !isDaotui) {
      let duanqiaoStop = -1, luzhangStop = -1;
      for (let i = 1; i <= diceValue; i++) {
        const passPos = (fromPos + i) % BOARD_SIZE;
        const passSpace = board[passPos];
        if (passSpace && passSpace.closed && passSpace.owner === current.id) passSpace.closed = false;
        if (passSpace && passSpace.type === 'start' && i < diceValue && current.frozen > 0) {}
        if (passSpace && passSpace.name === '断桥' && i < diceValue) { duanqiaoStop = passPos; break; }
        if (luzhangPositions.includes(passPos) && i < diceValue) { luzhangStop = passPos; break; }
      }
      if (duanqiaoStop >= 0) {
        const steps = (duanqiaoStop - fromPos + BOARD_SIZE) % BOARD_SIZE;
        current.position = duanqiaoStop;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('diceResult', { playerId: current.id, fromPos, dice: steps, newPos: duanqiaoStop });
        diceAnimState = { playerId: current.id, fromPos, dice: steps, newPos: duanqiaoStop, duanqiaoStop: true };
        return;
      }
      if (luzhangStop >= 0) {
        const steps = (luzhangStop - fromPos + BOARD_SIZE) % BOARD_SIZE;
        current.position = luzhangStop;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('diceResult', { playerId: current.id, fromPos, dice: steps, newPos: luzhangStop });
        diceAnimState = { playerId: current.id, fromPos, dice: steps, newPos: luzhangStop, luzhangStop: true };
        return;
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('diceResult', { playerId: current.id, fromPos, dice: diceValue, newPos });
      const landedOnLuzhang = luzhangPositions.includes(newPos);
      diceAnimState = { playerId: current.id, fromPos, dice: diceValue, newPos, luzhangStop: landedOnLuzhang };
      return;
    }

    if (diceValue > 0 && isDaotui) {
      let duanqiaoStop = -1, luzhangStop = -1;
      for (let i = 1; i <= diceValue; i++) {
        const passPos = (fromPos - i + BOARD_SIZE) % BOARD_SIZE;
        const passSpace = board[passPos];
        if (passSpace && passSpace.name === '断桥' && i < diceValue) { duanqiaoStop = passPos; break; }
        if (luzhangPositions.includes(passPos) && i < diceValue) { luzhangStop = passPos; break; }
      }
      if (duanqiaoStop >= 0) {
        const steps = (fromPos - duanqiaoStop + BOARD_SIZE) % BOARD_SIZE;
        current.position = duanqiaoStop;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('diceResult', { playerId: current.id, fromPos, dice: steps, newPos: duanqiaoStop, direction: 'backward' });
        diceAnimState = { playerId: current.id, fromPos, dice: steps, newPos: duanqiaoStop, duanqiaoStop: true, isDaotui };
        return;
      }
      if (luzhangStop >= 0) {
        const steps = (fromPos - luzhangStop + BOARD_SIZE) % BOARD_SIZE;
        current.position = luzhangStop;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('diceResult', { playerId: current.id, fromPos, dice: steps, newPos: luzhangStop, direction: 'backward' });
        diceAnimState = { playerId: current.id, fromPos, dice: steps, newPos: luzhangStop, luzhangStop: true, isDaotui };
        return;
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('diceResult', { playerId: current.id, fromPos, dice: diceValue, newPos, direction: 'backward' });
      const landedOnLuzhang = luzhangPositions.includes(newPos);
      diceAnimState = { playerId: current.id, fromPos, dice: diceValue, newPos, isDaotui, luzhangStop: landedOnLuzhang };
      return;
    }

    handleDiceLanding(socket, current, current.position, newPos);
  });

  socket.on('diceAnimDone', () => {
    if (!diceAnimState) return;
    const { playerId, fromPos, dice, newPos, duanqiaoStop, luzhangStop, isDaotui } = diceAnimState;
    if (socket.id !== playerId) return;
    diceAnimState = null;

    const movingPlayer = players.find(p => p.id === playerId);
    if (!movingPlayer) return;
    movingPlayer.position = newPos;
    updateShelteredState();

    if (duanqiaoStop) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(movingPlayer.name, movingPlayer.color)}被断桥拦下` });
      socket.emit('showEndTurn');
      return;
    }

    if (luzhangStop) {
      luzhangPositions = luzhangPositions.filter(p => p !== newPos);
      io.emit('luzhangTriggered', { position: newPos, playerId: movingPlayer.id });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(movingPlayer.name, movingPlayer.color)}被路障拦下` });
      handleDiceLanding(socket, movingPlayer, fromPos, newPos);
      return;
    }

    if (sansiState && sansiState.pendingAnim) {
      sansiState.pendingAnim = false;
      const targetSpace = board[newPos];
      const isStepMove = /前进|后退/.test(sansiState.selectedOption);
      const optionName = isStepMove ? sansiState.selectedOption : `${sansiState.selectedOption}→${targetSpace.name}`;
      const animTargetMsg = isStepMove ? '' : (sansiState.targetMsg || '');
      const remaining = sansiState.options.filter(o => o !== sansiState.selectedOption);
      sansiState.remainingOptions = remaining;
      if (sansiState.phase === 'select' || sansiState.phase === 'selectFlyTarget') {
        sansiState.phase = 'selectTarget';
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('sansiSelected', { playerId: movingPlayer.id, playerName: movingPlayer.name, playerColor: movingPlayer.color, option: optionName, remaining, targetMsg: animTargetMsg });
      } else if (sansiState.phase === 'otherSelect' || sansiState.phase === 'otherSelectFlyTarget') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('sansiComplete', { playerId: movingPlayer.id, playerName: movingPlayer.name, playerColor: movingPlayer.color, option: optionName, targetMsg: animTargetMsg });
        sansiState = null;
      }
      return;
    }

    const current = players[currentPlayerIndex];
    if (!current) return;
    current.position = newPos;
    if (isDaotui) {
      handleDiceLanding(socket, current, fromPos, newPos);
    } else {
      handleDiceLanding(socket, current, fromPos, newPos);
    }
  });

  function updateShelteredState() {
    const hezongSpace = board.find(s => s.type === 'hezong');
    const hezongPos = hezongSpace ? hezongSpace.id : -1;
    players.forEach(p => {
      if (!p.bankrupt) {
        p.sheltered = (p.shelteredTurns || 0) > 0;
        if (p.position !== hezongPos && (p.hezongState === 'forced' || p.hezongState === 'normal')) {
          p.hezongState = null;
          p.hezongTurns = 0;
          p.hezongTarget = null;
        }
      } else {
        p.sheltered = false;
        p.shelteredTurns = 0;
        if (p.hezongState) {
          p.hezongState = null;
          p.hezongTurns = 0;
          p.hezongTarget = null;
        }
      }
    });
  }

  function executeGaituEffect(socket, current, gaituName) {
    if (gaituName === '断桥') {
      const roll = Math.floor(Math.random() * 6) + 1;
      const doJudge = () => {
        const newRoll = Math.floor(Math.random() * 6) + 1;
        if (newRoll <= 3) {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `判定为${newRoll}，无法通过断桥` });
          socket.emit('showEndTurn');
        } else {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `判定为${newRoll}，请通过断桥` });
        }
      };
      const originalResult = () => {
        if (roll <= 3) {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `判定为${roll}，无法通过断桥` });
          socket.emit('showEndTurn');
        } else {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `判定为${roll}，请通过断桥` });
        }
      };
      if (checkKoiOrDuogongnengJudge(current.id, doJudge, originalResult)) {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `判定为${roll}，是否重新判定？` });
        return;
      }
      if (roll <= 3) {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `判定为${roll}，无法通过断桥` });
        socket.emit('showEndTurn');
      } else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `判定为${roll}，请通过断桥` });
      }
    } else if (gaituName === '土匪窝') {
      const ownedProperties = board.filter(s => s.isProperty && s.owner && !s.closed);
      if (ownedProperties.length === 0) {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: '无地可抢' });
        socket.emit('showEndTurn');
      } else {
        const shuffled = ownedProperties.sort(() => Math.random() - 0.5);
        const selected = shuffled.slice(0, Math.min(2, shuffled.length));
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: '请选择1块地抢劫路费，然后令其停业' });
        socket.emit('gaituRobChoice', { properties: selected.map(s => ({ id: s.id, name: s.name, owner: s.owner, rent: s.rent })) });
      }
    } else if (gaituName === '骰子屋') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: '是否令所有人-10并获得随机骰子？' });
      socket.emit('gaituDiceHouseChoice');
    } else if (gaituName === '避难所') {
      setPlayerState(current, 'shelteredTurns', 2);
      if (current.shelteredTurns) {
        updateShelteredState();
        applyRest(current.id, 2, `${coloredName(current.name, current.color)}进入避难所，无法成为他人目标`, socket);
      } else {
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}进入避难所，无法成为他人目标` });
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        if (socket) socket.emit('showEndTurn');
      }
    } else if (gaituName === '观音庙') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      socket.emit('gaituGuanyinChoice', { playerId: current.id });
    } else if (gaituName === '慈善屋') {
      players.forEach(p => {
        if (p.id !== current.id && !p.bankrupt && !p.sheltered) {
          previewMoney(current.id, -4);
          previewMoney(p.id, 4);
        }
      });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}做慈善，给每人4` });
      socket.emit('showEndTurn');
    } else if (gaituName === '加油站') {
      current.extraTurns = (current.extraTurns || 0) + 1;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}再动一次` });
      socket.emit('showEndTurn');
    } else if (gaituName === '传送门') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
      if (validTargets.length === 0) {
        io.emit('noValidTarget');
      } else {
        io.emit('updateAreaE', { message: '请选择其他角色互换位置' });
        socket.emit('gaituSwapChoice');
      }
    } else if (gaituName === '货车场') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: '请放置大运车，下回合开始自动撞人' });
      socket.emit('dayunPlaceMode');
    } else if (gaituName === '轮盘赌') {
      const totalPlayers = players.filter(p => !p.bankrupt && !p.sheltered).length;
      if (!rouletteRemaining) {
        rouletteRemaining = totalPlayers;
        rouletteTargets = [];
      }
      const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && !rouletteTargets.includes(p.id));
      if (validTargets.length === 0) {
        io.emit('noValidTarget');
      } else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `只有1颗子弹，请选择一名目标开枪，1/${rouletteRemaining}概率击中，未击中以后不可对该目标开枪` });
        socket.emit('gaituRouletteChoice', { rouletteTargets, rouletteRemaining });
      }
    }
  }

  function handleDiceLanding(socket, current, fromPos, newPos) {
    const space = board[newPos];
    if (!space) { const s = io.sockets.sockets.get(current.id); if (s) s.emit('showEndTurn'); return; }

    if (space.type === 'start') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `请选择奖励，抽中奇遇概率为1/6` });
      socket.emit('startChoice');
      return;
    }

    if (space.type === 'jail') {
      if (checkMianxiu(current.id, '进监狱区域')) {
        return;
      }
      if (current.hasDiamond) {
        returnDiamondIfHeld(current);
        io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
      }
      const msg = `${coloredName(current.name, current.color)}巨额财产来源不明罪，进医院`;
      io.emit('updateAreaE', { message: msg });
      setPlayerState(current, 'inJail', true);
      if (current.inJail) {
        current.jailState = 'justJailed';
        current.position = JAIL_JAIL_ID;
        io.emit('showJailMap', { players, board, currentPlayerIndex, message: msg, currentDiceValue });
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      socket.emit('showEndTurn');
      return;
    }
    
    if (space.type === 'diamond') {
      if (current.hasDiamond) {
        // 已获得钻石，如果已经是自己的颜色则进度+2
        if (diamondProgressPlayerId === current.id) {
          diamondProgress += 2;
          if (diamondProgress >= 11) {
            current.hasDiamond = false;
            diamondHolder = null;
            diamondProgress = 0;
            diamondProgressPlayerId = null;
            diamondProgressPlayerColor = null;
            previewMoney(current.id, 20);
            current.salary += 3;
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
            io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
            io.emit('diamondRedeemed', { playerName: current.name, playerColor: current.color });
            socket.emit('showEndTurn');
            return;
          }
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('diamondProgressUpdate', { playerId: current.id, playerColor: current.color, progress: diamondProgress });
          io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}已经获得钻石，进度+2`, currentDiceValue });
          socket.emit('showEndTurn');
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}已获得钻石`, currentDiceValue });
        socket.emit('showEndTurn');
        return;
      } else if (diamondHolder === true || diamondHolder === null) {
        current.hasDiamond = true;
        diamondHolder = current.id;
        diamondProgress = 0;
        diamondProgressPlayerId = current.id;
        diamondProgressPlayerColor = current.color;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('diamondProgressUpdate', { playerId: current.id, playerColor: current.color, progress: 0 });
        io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}获得钻石`, currentDiceValue });
        socket.emit('showEndTurn');
        return;
      } else {
        const holder = players.find(p => p.id === diamondHolder);
        if (holder) {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `是否抢夺钻石？与${coloredName(holder.name, holder.color)}拼钱` });
          socket.emit('diamondRob', { holderId: holder.id, holderName: holder.name, holderColor: holder.color, holderMoney: holder.money, robberMoney: current.money });
          return;
        }
      }
    }

    if (space.type === 'property' && space.isProperty && !space.owner) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters });
      if (current.fengdiTurns > 0) {
        io.emit('updateAreaE', { message: '封地禁令，无法购买地产/建房' });
        socket.emit('showEndTurn');
      } else {
        socket.emit('canBuy', { space, dice: currentDiceValue });
      }
      return;
    } else if (space.type === 'property' && space.isProperty && space.owner && space.owner !== current.id) {
      const owner = players.find(p => p.id === space.owner);
      if (owner) {
        if (space.closed) {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `该地产已停业` });
          socket.emit('showEndTurn');
          return;
        }
        if (owner.restTurns > 0) {
          if (space.name === '青海') {
            const ownerIndex = players.findIndex(p => p.id === owner.id);
            // 检查地主M3是否有状态图标
            const ownerHasStatus = playerHasStatus(owner);
            if (!ownerHasStatus) {
              // 没有状态，不发动湖眼
              io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
              io.emit('updateAreaE', { message: `${coloredName(owner.name, owner.color)}休息，免交路费` });
              socket.emit('showEndTurn');
            } else {
              qinghaiState = {
                originalPlayerIndex: currentPlayerIndex,
                ownerSocketId: owner.id,
                ownerIndex: ownerIndex,
                playerName: current.name,
                playerColor: current.color,
                ownerName: owner.name,
                ownerColor: owner.color,
                rent: getRent(space)
              };
              currentPlayerIndex = ownerIndex;
              io.emit('turnUpdate', { players, board, currentPlayerIndex, currentDiceValue });
              io.emit('updateAreaE', { message: `忧郁不败发动青海湖眼，是否随机清除自身1个状态？` });
              const ownerSocket = io.sockets.sockets.get(owner.id);
              if (ownerSocket) {
                ownerSocket.emit('qinghaiHuyanChoice', { ownerName: owner.name, ownerColor: owner.color });
              }
            }
          } else {
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
            io.emit('updateAreaE', { message: `${coloredName(owner.name, owner.color)}休息，免交路费` });
            socket.emit('showEndTurn');
          }
          return;
        }
        if (owner.inJail && owner.jailState !== 'leaving') {
          if (space.name === '青海') {
            const ownerIndex = players.findIndex(p => p.id === owner.id);
            const ownerHasStatus = playerHasStatus(owner);
            if (!ownerHasStatus) {
              io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
              io.emit('updateAreaE', { message: `${coloredName(owner.name, owner.color)}休息，免交路费` });
              socket.emit('showEndTurn');
            } else {
              qinghaiState = {
                originalPlayerIndex: currentPlayerIndex,
                ownerSocketId: owner.id,
                ownerIndex: ownerIndex,
                playerName: current.name,
                playerColor: current.color,
                ownerName: owner.name,
                ownerColor: owner.color,
                rent: getRent(space)
              };
              currentPlayerIndex = ownerIndex;
              io.emit('turnUpdate', { players, board, currentPlayerIndex, currentDiceValue });
              io.emit('updateAreaE', { message: `忧郁不败发动青海湖眼，是否随机清除自身1个状态？` });
              const ownerSocket = io.sockets.sockets.get(owner.id);
              if (ownerSocket) {
                ownerSocket.emit('qinghaiHuyanChoice', { ownerName: owner.name, ownerColor: owner.color });
              }
            }
          } else {
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
            io.emit('updateAreaE', { message: `${coloredName(owner.name, owner.color)}休息，免交路费` });
            socket.emit('showEndTurn');
          }
          return;
        } else {
          const rent = getRent(space);
          const afterRentPaid = (paid) => {
            if (paid) {
              deductMoney(current.id, rent);
              previewMoney(owner.id, rent);
            }
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
            if (paid && checkBankruptcy(current)) { nextTurn(); return; }
            if (space.name === '新疆') {
            const ownerIndex = players.findIndex(p => p.id === owner.id);
            xinjiangMoveState = {
              originalPlayerIndex: currentPlayerIndex,
              ownerSocketId: owner.id,
              ownerIndex: ownerIndex,
              playerName: current.name,
              playerColor: current.color,
              ownerName: owner.name,
              ownerColor: owner.color,
              rent: rent
            };
            currentPlayerIndex = ownerIndex;
            const canMoveBack = owner.position !== 0;
            io.emit('turnUpdate', { players, board, currentPlayerIndex, currentDiceValue });
            io.emit('updateAreaE', { message: `${coloredName(owner.name, owner.color)}，新疆丝绸之路，请选择移动` });
            const ownerSocket = io.sockets.sockets.get(owner.id);
            if (ownerSocket) {
              ownerSocket.emit('xinjiangMove', { canMoveBack, ownerName: owner.name, ownerColor: owner.color });
            }
          } else if (space.name === '西藏') {
            const ownerIndex = players.findIndex(p => p.id === owner.id);
            xizangState = {
              originalPlayerIndex: currentPlayerIndex,
              ownerSocketId: owner.id,
              ownerIndex: ownerIndex,
              playerName: current.name,
              playerColor: current.color,
              ownerName: owner.name,
              ownerColor: owner.color,
              rent: rent
            };
            currentPlayerIndex = ownerIndex;
            io.emit('turnUpdate', { players, board, currentPlayerIndex, currentDiceValue });
            io.emit('updateAreaE', { message: `${coloredName(owner.name, owner.color)}西藏参悟，请选择下回合掷大点还是小点` });
            const ownerSocket = io.sockets.sockets.get(owner.id);
            if (ownerSocket) {
              ownerSocket.emit('xizangChoice', { ownerName: owner.name, ownerColor: owner.color });
            }
          } else if (space.name === '广西') {
            const playerProperties = board.filter(s => s.owner === current.id && s.type === 'property' && s.isProperty);
            if (playerProperties.length > 0) {
              guangxiState = {
                originalPlayerId: current.id,
                ownerSocketId: owner.id,
                playerName: current.name,
                playerColor: current.color,
                ownerName: owner.name,
                ownerColor: owner.color,
                guangxiId: space.id,
                rent: rent
              };
              io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
              socket.emit('guangxiChoice', { properties: playerProperties.map(p => ({ id: p.id, name: p.name })), ownerName: owner.name, ownerColor: owner.color, playerName: current.name, playerColor: current.color, rent });
            } else {
              io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
              io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}` });
              socket.emit('showEndTurn');
            }
          } else if (space.name === '三思') {
            applyRest(current.id, 1, `${coloredName(current.name, current.color)}休息1回合`, socket);
          } else if (space.name === '泰山') {
            const targetPos = current.position === 0 ? board.length - 3 : current.position - 3;
            io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}，后退3格` });
            io.emit('taishanBackward', { playerId: current.id, fromPos: current.position, toPos: targetPos });
            current.position = targetPos;
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
            socket.emit('showEndTurn');
          } else if (space.name === '衡山') {
            applyRest(current.id, 1, `${coloredName(current.name, current.color)}休息1回合`, socket);
          } else if (space.name === '机场' && space.airportType && (space.airportType === '度假机' || space.airportType === '观光机')) {
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
            // 判定前直接生成结束按钮，判定后不再生成
            socket.emit('showEndTurn');
            if (space.airportType === '度假机') {
      const roll = Math.floor(Math.random() * 4) + 3;
              const doDujiajiJudge = () => {
                const newRoll = Math.floor(Math.random() * 6) + 1;
                if (newRoll <= 2) {
                  sendToIsland(current.id, () => {
                    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}，判定为${newRoll}，飞往海南` });
                  });
                } else if (newRoll <= 4) {
                  applyRest(current.id, 1, `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}，判定为${newRoll}，休息1回合`, socket);
                } else {
                  io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}，判定为${newRoll}，无事发生` });
                }
              };
              const originalResult = () => {
                if (roll <= 2) {
                  sendToIsland(current.id, () => {
                    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}，判定为${roll}，飞往海南` });
                  });
                } else if (roll <= 4) {
                  applyRest(current.id, 1, `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}，判定为${roll}，休息1回合`, socket);
                } else {
                  io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}，判定为${roll}，无事发生` });
                }
              };
              if (checkKoiOrDuogongnengJudge(current.id, doDujiajiJudge, originalResult)) {
                let resultText = roll <= 2 ? '飞往海南' : (roll <= 4 ? '休息1回合' : '无事发生');
                io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}，判定为${roll}，${resultText}，是否重新判定？` });
                return;
              }
              if (roll <= 2) {
                sendToIsland(current.id, () => {
                  io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}，判定为${roll}，飞往海南` });
                });
              } else if (roll <= 4) {
                applyRest(current.id, 1, `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}，判定为${roll}，休息1回合`, socket);
              } else {
                io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}，判定为${roll}，无事发生` });
              }
            } else if (space.airportType === '观光机') {
              const newPos = Math.floor(Math.random() * 36);
              current.position = newPos;
              io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
              io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}，被弹飞到${board[newPos].name}` });
            }
          } else {
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
            io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}交给${coloredName(owner.name, owner.color)}路费${rent}` });
            const payerPetInfo = getPetInfo(current.petImage);
            if (payerPetInfo && payerPetInfo.name === '穷奇' && !current.petFlipped && owner.money > 0) {
              startQiongqiPinqian(current, owner, socket);
              return;
            }
            if (payerPetInfo && payerPetInfo.name === '青龙' && !current.petFlipped) {
              startQinglongPinqian(current, owner, current.position, socket);
              return;
            }
            // 和平熊猫：交路费后检查当前空地
            if (payerPetInfo && payerPetInfo.name === '和平熊猫' && !current.petFlipped && (!space.houseLevel || space.houseLevel === 0)) {
              io.emit('bAreaOverlay', { imageSrc: '/drawable/chongwu/16.png', name: '和平熊猫', playerName: current.name, playerColor: current.color });
              const currentSocket = io.sockets.sockets.get(current.id);
              if (currentSocket) {
                currentSocket.emit('hepingxiongmaoTck', { propertyName: space.name, ownerName: owner.name, ownerColor: owner.color, propertyOwnerId: owner.id });
              }
              return;
            }
            // 毒蛇：交路费后令地主M3获得毒蛇标记
            if (payerPetInfo && payerPetInfo.name === '毒蛇' && !current.petFlipped) {
              if (!owner.snakeReduction) owner.snakeReduction = 0;
              if (owner.snakeReduction < 6) {
                owner.snakeReduction = Math.min(6, owner.snakeReduction + 2);
              }
              io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
              io.emit('updateAreaE', { message: `${coloredName(owner.name, owner.color)}被毒蛇咬伤，点数上限-${owner.snakeReduction}` });
            }
            checkWolfAfterRent(current.id, owner.id, socket);
          }
          };
          // 白虎：交路费前猜数
          if (current.petImage && !current.petFlipped) {
            const payerPetInfo = getPetInfo(current.petImage);
            if (payerPetInfo && payerPetInfo.name === '白虎') {
              pendingBaihuState = { payerId: current.id, ownerId: owner.id, rent, payerName: current.name, payerColor: current.color, ownerName: owner.name, ownerColor: owner.color, space, payerChoice: null, ownerChoice: null };
              io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
              io.emit('updateAreaE', { message: `白虎猜测地主${coloredName(owner.name, owner.color)}给钱2-4，猜对免交路费` });
              const payerSocket = io.sockets.sockets.get(current.id);
              const ownerSocket = io.sockets.sockets.get(owner.id);
              if (payerSocket) payerSocket.emit('baihuGuess', {});
              if (ownerSocket) ownerSocket.emit('baihuGuess', {});
              return;
            }
          }
          const mianlufeiIdx = current.cards ? current.cards.findIndex(c => c.name === '免路费卡') : -1;
          if (mianlufeiIdx !== -1) {
            pendingCardConfirm = {
              playerId: current.id,
              cardName: '免路费卡',
              cardIndex: mianlufeiIdx,
              reason: 'mianlufei',
              spaceId: space.id,
              rent,
              onUsed: () => {
                current.cards.splice(mianlufeiIdx, 1);
                io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
                io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用免路费卡免除了路费` });
                socket.emit('showEndTurn');
              },
              onNotUsed: () => {
                if (checkDuogongnengRent(current.id, rent, () => {
                  const reducedRent = Math.max(0, rent - 10);
                  previewMoney(current.id, -reducedRent);
                  previewMoney(owner.id, reducedRent);
                  io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
                  if (checkBankruptcy(current)) { nextTurn(); return; }
                  socket.emit('showEndTurn');
                })) {
                  return;
                }
                afterRentPaid(true);
              }
            };
            socket.emit('cardConfirmPopup', { cardName: '免路费卡', image: 'mianlufei', description: `免路费卡：即将交路费${rent}，是否使用免路费卡免除路费？`, reason: 'mianlufei' });
            return;
          }
          if (checkDuogongnengRent(current.id, rent, () => {
            const reducedRent = Math.max(0, rent - 10);
            previewMoney(current.id, -reducedRent);
            previewMoney(owner.id, reducedRent);
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
            if (checkBankruptcy(current)) { nextTurn(); return; }
            socket.emit('showEndTurn');
          })) {
            return;
          }
          afterRentPaid(true);
          return;
        }
      }
    } else if (space.type === 'property' && space.owner === current.id) {
      if (space.name === '机场') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        socket.emit('airportChoice', { 
          spaceName: space.displayName || space.name,
          houseLevel: space.houseLevel,
          buildCost: Math.round(space.price / 4),
          airportType: space.airportType || null,
          spaceId: space.id
        });
        return;
      }
      const excludedProperties = ['台湾'];
      if (space.name === '新疆') {
        const buildCost = Math.round(space.price / 4);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        socket.emit('xinjiangOwn', { spaceName: space.name, houseLevel: space.houseLevel, buildCost });
        return;
      }
      if (space.name === '西藏') {
        const buildCost = Math.round(space.price / 4);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        socket.emit('xizangOwn', { spaceName: space.name, houseLevel: space.houseLevel, buildCost });
        return;
      }
      if (space.name === '广西') {
        const buildCost = Math.round(space.price / 4);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        socket.emit('guangxiOwn', { spaceName: space.name, houseLevel: space.houseLevel, buildCost, ownerName: current.name, ownerColor: current.color });
        return;
      }
      if (space.name === '五岳' || ['泰山','嵩山','恒山','衡山','华山'].includes(space.name)) {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        socket.emit('wuyueChoice', { spaceName: space.name, houseLevel: space.houseLevel, buildCost: Math.round(space.price / 4), spaceId: space.id });
        return;
      }
      if (space.name === '香港') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        const activePlayers = players.filter(p => !p.bankrupt);
        const randomPlayer = activePlayers[Math.floor(Math.random() * activePlayers.length)];
        socket.emit('hongkongChoice', { 
          spaceName: space.name, 
          houseLevel: space.houseLevel, 
          buildCost: Math.round(space.price / 4),
          ownerId: current.id,
          ownerName: current.name,
          ownerColor: current.color,
          randomPlayerName: randomPlayer.name,
          randomPlayerColor: randomPlayer.color,
          randomPlayerId: randomPlayer.id
        });
        return;
      }
      if (space.name === '台湾') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        socket.emit('taiwanChoice', { spaceName: space.name, houseLevel: space.houseLevel, buildCost: Math.round(space.price / 4) });
        return;
      }
      if (space.name === '香港') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        const activePlayers = players.filter(p => !p.bankrupt);
        const randomPlayer = activePlayers[Math.floor(Math.random() * activePlayers.length)];
        socket.emit('hongkongChoice', { 
          spaceName: space.name, 
          houseLevel: space.houseLevel, 
          buildCost: Math.round(space.price / 4),
          ownerId: current.id,
          ownerName: current.name,
          ownerColor: current.color,
          randomPlayerName: randomPlayer.name,
          randomPlayerColor: randomPlayer.color,
          randomPlayerId: randomPlayer.id
        });
        return;
      }
      if (space.name === '澳门') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        socket.emit('macauChoice', { 
          spaceName: space.name, 
          houseLevel: space.houseLevel, 
          buildCost: Math.round(space.price / 4),
          ownerId: current.id,
          ownerName: current.name,
          ownerColor: current.color
        });
        return;
      }
      if (!excludedProperties.includes(space.name)) {
        if (space.houseLevel < 4) {
          const buildCost = Math.round(space.price / 4);
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          socket.emit('buildChoice', { spaceName: space.name, buildCost, houseLevel: space.houseLevel });
          return;
        } else {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `${space.name}已经满级` });
          socket.emit('showEndTurn');
          return;
        }
      }
    } else if (space.type === 'chance') {
      const selectedJiyu = weightedRandomJiyu();
      // 发送机遇动图显示事件（仅当前玩家）
      socket.emit('jiyuShowGif');
      // 存储待处理的机遇卡，等待玩家选择
      jiyuPendingState = {
        playerId: current.id,
        jiyu: selectedJiyu
      };
      // 发送机遇卡信息给客户端显示STIP
      const hasDuogongneng = current.cards && current.cards.some(c => c.name === '多功能卡');
      const hasKoi = hasKoiPet(current);
      socket.emit('jiyuCardShow', { name: selectedJiyu.name, desc: selectedJiyu.desc, hasDuogongneng, hasKoi });
      io.emit('updateAreaE', { message: '是否重新抽机遇？' });
      if (hasKoi || hasDuogongneng) {
        const oimgs = [];
        if (hasKoi) oimgs.push('/drawable/chongwu/8.png');
        if (hasDuogongneng) oimgs.push('/drawable/kapian/duogongneng.png');
        io.emit('koiDuogongnengOverlay', { imgs: oimgs, targetPlayerId: current.id });
      }
      return;
    } else if (space.type === 'pinqian') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      socket.emit('pinqianSelect');
      return;
    } else if (space.type === 'changjiang') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      if (space.name === '黄河') {
        socket.emit('huangheChoice');
      } else {
        socket.emit('changjiangChoice');
      }
      return;
    } else if (space.type === 'gaitu') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      if (space.name === '改土') {
        socket.emit('gaituChoice');
      } else {
        executeGaituEffect(socket, current, space.name);
      }
      return;
    } else if (space.type === 'hezong') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      const hezongSpace = board.find(s => s.type === 'hezong');
      const hezongPos = hezongSpace ? hezongSpace.id : 30;
      const hezongPlayers = players.filter(p => p.id !== current.id && p.position === hezongPos && (p.hezongState === 'forced' || p.hezongState === 'normal'));
      if (hezongPlayers.length > 0) {
        const hezongPlayer = hezongPlayers[0];
        socket.emit('hezongIncoming', { hezongPlayerId: hezongPlayer.id, hezongPlayerName: hezongPlayer.name });
      } else {
        socket.emit('hezongChoice');
      }
      return;
    } else if (space.type === 'siheyuan') {
      const suits = ['hongtao', 'meihua', 'fangkuai', 'heitao'];
      const suitSymbols = { hongtao: '♥', meihua: '♣', fangkuai: '♦', heitao: '♠' };
      const deck = [];
      for (let i = 0; i < 52; i++) {
        deck.push(suits[i % 4]);
      }
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      const drawn = deck.slice(0, 8);
      const row2Suits = drawn.slice(0, 4);
      const row3Suits = drawn.slice(4, 8);
      const allRevealedSuits = new Set(row2Suits);
      const missingInit = suits.filter(s => !allRevealedSuits.has(s));
      const isTianhu = missingInit.length === 0;
      siheyuanState = {
        playerId: current.id,
        playerName: current.name,
        playerColor: current.color,
        row2Suits,
        row3Suits,
        revealed: [false, false, false, false],
        allRevealedSuits: new Set(row2Suits),
        isTianhu
      };
      if (isTianhu) {
        previewMoney(current.id, 10);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}天胡，+10` });
        socket.emit('siheyuanStart', { row2Suits, row3Suits, isTianhu, playerName: current.name, playerColor: current.color, missingSuits: [] });
        io.emit('siheyuanWatch', { row2Suits, row3Suits, revealed: [false, false, false, false], playerName: current.name, playerColor: current.color, playerId: current.id });
        return;
      }
      previewMoney(current.id, -3);
      const missingSymbols = missingInit.map(s => suitSymbols[s]).join('');
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `强制门票3，$3翻开1张卡，还差${missingSymbols}` });
      socket.emit('siheyuanStart', { row2Suits, row3Suits, isTianhu: false, playerName: current.name, playerColor: current.color, missingSuits: missingInit });
      io.emit('siheyuanWatch', { row2Suits, row3Suits, revealed: [false, false, false, false], playerName: current.name, playerColor: current.color, playerId: current.id });
      return;
    } else if (space.type === 'auction') {
      const excludedCardIds = [0, 5, 13, 15, 21, 24, 26, 61, 62, 63, 64, 65];
      const availableCards = cardData.filter(c => !excludedCardIds.includes(c.id));
      const auctionCard1 = availableCards[Math.floor(Math.random() * availableCards.length)];
      const auctionCard2 = availableCards[Math.floor(Math.random() * availableCards.length)];

      // 创建伪装版本（用于隐藏卡）
      const getDisplayCard = (card) => {
        if (card.id === 6 || card.name === '隐藏卡') {
          return { id: 6, name: '隐藏卡', description: '隐藏卡：成为目标时触发，效果仅卡主可见', image: 'yincang' };
        }
        return card;
      };

      const displayCard1 = getDisplayCard(auctionCard1);
      const displayCard2 = getDisplayCard(auctionCard2);

      const activePlayers = players.filter(p => !p.bankrupt);
      auctionState = {
        card1: auctionCard1,
        card2: auctionCard2,
        bids: {},
        passedPlayers: [],
        currentBidderIndex: activePlayers.findIndex(p => p.id === current.id),
        activePlayers: activePlayers.map(p => p.id),
        currentBid: 0,
        lastBidderId: null
      };
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('auctionStart', {
        card1: displayCard1,
        card2: displayCard2,
        currentBidderId: current.id,
        currentBidderName: current.name,
        currentBidderColor: current.color
      });
      return;
    } else if (space.type === 'kunlun') {
      if (kunlunState && kunlunState.playerId === current.id) {
        // 已是自己的颜色，直接触发昆仑TCK
        kunlunFromTurn = true;
        kunlunState.progress = 0;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, kunlunState });
        io.emit('kunlunArrive', { playerId: current.id, playerName: current.name, playerColor: current.color, progress: 0 });
        triggerKunlunPanel(current);
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}收到了仙人的礼物` });
        return;
      } else {
        kunlunState = {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          progress: 0
        };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, kunlunState });
        io.emit('kunlunArrive', { playerId: current.id, playerName: current.name, playerColor: current.color, progress: 0 });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}被仙人赐福` });
      }
      socket.emit('showEndTurn');
      return;
    } else if (space.type === 'pet') {
      const randomDw = Math.floor(Math.random() * 9) + 1;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: '请选择一项进行拍卖' });
      socket.emit('petShopPanel', { playerId: current.id, gifIndex: randomDw });
      return;
    } else {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      if (space.name === '三思') {
        let sansiOptions = [...allSansiOptions];
        // 随机抽取3项
        const shuffled = sansiOptions.sort(() => Math.random() - 0.5);
        sansiOptions = shuffled.slice(0, 3);

        sansiState = { playerId: current.id, playerName: current.name, playerColor: current.color, options: sansiOptions, phase: 'select', selectedOption: null, remainingOptions: [], targetId: null };
        io.emit('sansiPanel', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          options: sansiOptions
        });
      } else {
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}进入了${space.name}` });
        socket.emit('showEndTurn');
      }
      return;
    }

    nextTurn();
  }

  
  socket.on('diamondSelect', ({ propertyId, price }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    if (propertyId === null) {
      // æ”¾å¼ƒ

      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}æ”¾å¼ƒ` });
      socket.emit('showEndTurn');
      return;
    }
    

    current.money -= price;
    const space = board.find(s => s.id === propertyId);
    if (space) {


    }
    socket.emit('showEndTurn');
  });

  socket.on('confirmGoToJail', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (current.inJail && current.jailState === 'justJailed') {
      const msg = `${coloredName(current.name, current.color)}巨额财产来源不明罪，进监狱`;
      io.emit('showJailMap', { players, board, currentPlayerIndex, message: msg });
    }
  });

  socket.on('islandGoHospital', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!current.inJail || current.jailState !== 'island') return;
    if (current.money >= 16) {
      previewMoney(current.id, -16);
      setPlayerState(current, 'inJail', true);
      current.jailState = 'hospital';
      current.position = JAIL_HOSPITAL_ID;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}花16到医院`, currentDiceValue });
      io.emit('showEndTurn');
    }
  });

  socket.on('islandTreasureClose', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    current.jailState = 'island';
    io.emit('islandTreasureClosed', { currentPlayerId: current.id, playerName: current.name, playerColor: current.color });
  });

  socket.on('islandTreasureMove', ({ pos }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    socket.broadcast.emit('islandTreasureMove', { pos });
  });

  socket.on('islandTreasureResult', ({ success }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (success) {
      current.money += 20;
    } else {
      current.money -= 5;
    }
    current.jailState = 'island';
    io.emit('islandTreasureClosed', { currentPlayerId: current.id, success, moneyChange: success ? 20 : -5, playerName: current.name, playerColor: current.color });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
    socket.emit('showEndTurn');
  });

  socket.on('islandSwapBid', ({ price }) => {
    const bidder = players.find(p => p.id === socket.id);
    if (!bidder || bidder.bankrupt || bidder.sheltered) return;
    const current = players[currentPlayerIndex];
    if (!current || !current.inJail || current.jailState !== 'island') return;
    if (bidder.id === current.id) return;
    islandSwapBids[bidder.id] = { playerId: bidder.id, playerName: bidder.name, playerColor: bidder.color, price: price || 0 };
    const allOtherPlayers = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
    const allResponded = allOtherPlayers.every(p => islandSwapBids[p.id] !== undefined);
    if (allResponded) {
      const bids = Object.values(islandSwapBids);
      const validBids = bids.filter(b => b.price >= 0);
      const currentSocket = io.sockets.sockets.get(current.id);
      if (validBids.length === 0) {
        io.emit('islandSwapNoBids');
      } else {
        if (currentSocket) currentSocket.emit('islandSwapSelectTarget', { bids: validBids });
        io.emit('islandSwapShowBids', { bids: validBids });
        io.emit('updateAreaE', { message: `所有人已报价，请支付价格与他换位` });
      }
    }
  });

  socket.on('islandSwapReject', () => {
    const bidder = players.find(p => p.id === socket.id);
    if (!bidder || bidder.bankrupt || bidder.sheltered) return;
    const current = players[currentPlayerIndex];
    if (!current || !current.inJail || current.jailState !== 'island') return;
    if (bidder.id === current.id) return;
    islandSwapBids[bidder.id] = { playerId: bidder.id, playerName: bidder.name, playerColor: bidder.color, price: -1 };
    const allOtherPlayers = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
    const allResponded = allOtherPlayers.every(p => islandSwapBids[p.id] !== undefined);
    if (allResponded) {
      const bids = Object.values(islandSwapBids);
      const validBids = bids.filter(b => b.price >= 0);
      const currentSocket = io.sockets.sockets.get(current.id);
      if (validBids.length === 0) {
        io.emit('islandSwapNoBids');
      } else {
        if (currentSocket) currentSocket.emit('islandSwapSelectTarget', { bids: validBids });
        io.emit('islandSwapShowBids', { bids: validBids });
        io.emit('updateAreaE', { message: `所有人已报价，请支付价格与他换位` });
      }
    }
  });

  socket.on('islandSwapAccept', ({ targetId, price }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!current.inJail || current.jailState !== 'island') return;
    const target = players.find(p => p.id === targetId);
    if (!target) return;
    if (current.money < price) return;
    previewMoney(current.id, -price);
    previewMoney(target.id, price);
    const tempPos = current.position;
    current.position = target.position;
    target.position = tempPos;
    const applyJailState = (player) => {
      if (player.position === JAIL_ISLAND_ID) {
        setPlayerState(player, 'inJail', true);
        player.jailState = 'island';
      } else if (player.position === JAIL_HOSPITAL_ID) {
        setPlayerState(player, 'inJail', true);
        player.jailState = 'hospital';
      } else if (player.position === JAIL_JAIL_ID) {
        if (returnDiamondIfHeld(player)) {
          io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
        }
        setPlayerState(player, 'inJail', true);
        player.jailState = 'jail';
      } else if (player.position === JAIL_FREE_ID) {
        setPlayerState(player, 'inJail', true);
        player.jailState = 'health';
      } else {
        player.inJail = false;
        player.jailState = null;
      }
    };
    applyJailState(current);
    applyJailState(target);
    islandSwapBids = {};
    io.emit('islandSwapClear');
    io.emit('islandSwapDone', { playerId: current.id, playerName: current.name, playerColor: current.color, targetName: target.name, targetColor: target.color, price });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}花了${price}与${coloredName(target.name, target.color)}互换了位置`, currentDiceValue });
    io.emit('showEndTurn');
  });

  socket.on('diamondRobFight', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const holder = players.find(p => p.id === diamondHolder);
    if (!holder) return;
    pinqianState = {
      currentPlayerId: current.id,
      targetPlayerId: holder.id,
      currentPlayerName: current.name,
      targetPlayerName: holder.name,
      currentNumber: 0,
      targetNumber: 0,
      currentConfirmed: false,
      targetConfirmed: false,
      isDiamondRob: true,
      resultType: 'diamondRob'
    };
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('pinqianStart', {
      playerName: current.name,
      playerColor: current.color,
      targetName: holder.name,
      targetColor: holder.color,
      isCurrent: true
    });
    const targetSocket = io.sockets.sockets.get(holder.id);
    if (targetSocket) {
      targetSocket.emit('pinqianStart', {
        playerName: current.name,
        playerColor: current.color,
        targetName: holder.name,
        targetColor: holder.color,
        isCurrent: false
      });
    }
  });

  socket.on('endTurn', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;

    // 清空所有卡片使用状态
    longjuanfengState = null;
    bingdongState = null;
    chuansongState = null;
    fengdiCardState = null;
    shuimianState = null;
    xianhaiState = null;
    chuansongSelecting = false;
    shanxianSelecting = false;
    tingyeState = null;
    // 临时金钱回合减少
    if (current.tempTurns && current.tempTurns > 0) {
      current.tempTurns--;
      if (current.tempTurns <= 0) {
        current.tempMoney = 0;
        current.tempTurns = 0;
      }
    }

    if (dizhuState && dizhuState.playerId === current.id && current.dizhuTurns > 0) {
      current.dizhuTurns--;
      if (current.dizhuTurns === 0) {
        dizhuState.originalOwners.forEach(item => {
          const prop = board.find(s => s.id === item.id);
          if (prop) prop.owner = item.owner;
        });
        dizhuState = null;
      }
    }

    if (current.fengdiTurns > 0) {
      current.fengdiTurns--;
    }
    
    qiyuState = null;
    currentDiceValue = 0;
    io.emit('closeGaituPanel');
    
    if (worldWarActive) {
      players.forEach(p => {
        if (!p.bankrupt) {
          previewMoney(p.id, -10);
        }
      });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    }

    if (current.hasDiamond && !current.inJail) {
      diamondProgress++;
      if (diamondProgress >= 11) {
        current.hasDiamond = false;
        diamondHolder = null;
        current.money += 20;
        current.salary += 3;
        diamondProgress = 0;
        diamondProgressPlayerId = null;
        diamondProgressPlayerColor = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
        io.emit('diamondRedeemed', { playerName: current.name, playerColor: current.color });
      } else {
        io.emit('diamondProgressUpdate', { playerId: diamondProgressPlayerId, playerColor: diamondProgressPlayerColor, progress: diamondProgress });
      }
    }

    if (current.inJail && current.jailState === 'justJailed') {
      current.jailState = 'jail';
      current.position = JAIL_JAIL_ID;
    } else if (current.inJail && current.jailState === 'leaving') {
      current.inJail = false;
      current.jailState = null;
      current.position = 1;
    }

    islandSwapBids = {};
    io.emit('islandSwapClear');

    if ((current.extraTurns || 0) > 0) {
      current.extraTurns--;
      currentDiceValue = 0;
      io.emit('extraTurnHighlight', { playerId: current.id });
      startCurrentTurn();
      return;
    }

    if (current.fuwufeiExtraMove) {
      current.fuwufeiExtraMove = false;
      currentDiceValue = 0;
      io.emit('extraTurnHighlight', { playerId: current.id });
      startCurrentTurn();
      return;
    }

    if (current.money < 0 && !current.bankrupt) {
      if (checkBankruptcy(current)) nextTurn();
      return;
    }

    // 夏蝉技能冷却
    if (current.cicadaSkillCooldown > 0) {
      current.cicadaSkillCooldown--;
      if (current.cicadaSkillCooldown <= 0) {
        delete current.cicadaSkillCooldown;
        socket.emit('cicadaSkillReady');
      }
    }

    nextTurn();
  });

  socket.on('bailJail', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (current.inJail && current.jailState === 'jail') {
      if (current.money < 8) return socket.emit('error', '余额不足，无法操作');
      previewMoney(current.id, -8);
      current.jailState = 'health';
      current.position = JAIL_FREE_ID;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}保释`, currentDiceValue });
      socket.emit('showEndTurn');
    }
  });

  socket.on('judgeJail', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (current.inJail && current.jailState === 'jail') {
      const roll = Math.floor(Math.random() * 6) + 1;
      const doJudge = () => {
        const newRoll = Math.floor(Math.random() * 6) + 1;
        if (newRoll === 1) {
          sendToIsland(current.id, () => {
            io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}判定为${newRoll}，到海南`, currentDiceValue });
            socket.emit('showEndTurn');
          });
        }
        else if (newRoll <= 5) {
          sendToHospital(current.id, '监狱判定', () => {
            io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}判定为${newRoll}，到医院`, currentDiceValue });
            socket.emit('showEndTurn');
          });
        }
        else {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}判定为${newRoll}，继续在监狱`, currentDiceValue });
          socket.emit('showEndTurn');
        }
      };
      const originalResult = () => {
        if (roll === 1) {
          sendToIsland(current.id, () => {
            io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}判定为${roll}，到海南`, currentDiceValue });
            socket.emit('showEndTurn');
          });
        }
        else if (roll <= 5) {
          sendToHospital(current.id, '监狱判定', () => {
            io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}判定为${roll}，到医院`, currentDiceValue });
            socket.emit('showEndTurn');
          });
        }
        else {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}判定为${roll}，继续在监狱`, currentDiceValue });
          socket.emit('showEndTurn');
        }
      };
      if (checkKoiOrDuogongnengJudge(current.id, doJudge, originalResult)) {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        let dest;
        if (roll === 1) dest = '海南';
        else if (roll <= 5) dest = '医院';
        else dest = '监狱';
        io.emit('updateAreaE', { message: `判定为${roll}，到${dest}，是否重新判定？` });
        return;
      }
      if (roll === 1) {
        sendToIsland(current.id, () => {
          io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}判定为${roll}，到海南`, currentDiceValue });
          socket.emit('showEndTurn');
        });
      }
      else if (roll <= 5) {
        sendToHospital(current.id, '监狱判定', () => {
          io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}判定为${roll}，到医院`, currentDiceValue });
          socket.emit('showEndTurn');
        });
      }
      else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}判定为${roll}，继续在监狱`, currentDiceValue });
        socket.emit('showEndTurn');
      }
    }
  });

  socket.on('xinjiangBuild', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.id === current.position);
      if (!space || space.name !== '新疆') return;
    if (space.houseLevel >= 4) return;
    const buildCost = Math.round(space.price / 4);
    if (current.money < buildCost) return;
    previewMoney(current.id, -buildCost);
    space.houseLevel = (space.houseLevel || 0) + 1;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('xinjiangAfterBuild', { spaceName: space.name, houseLevel: space.houseLevel, ownerName: current.name, ownerColor: current.color });
  });

  socket.on('xinjiangMoveOwn', (direction) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (direction === 'forward') {
      current.position = (current.position + 1) % BOARD_SIZE;
    } else if (direction === 'backward') {
      current.position = current.position === 0 ? BOARD_SIZE - 1 : current.position - 1;
    }
    updateShelteredState();
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('xinjiangMoveOwnDone');
  });

  socket.on('xizangBuildOwn', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.id === current.position);
    if (!space || space.name !== '西藏' || space.owner !== current.id) return;
    if (space.houseLevel >= 4) return;
    const buildCost = Math.round(space.price / 4);
    if (current.money < buildCost) return;
    previewMoney(current.id, -buildCost);
    space.houseLevel = (space.houseLevel || 0) + 1;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('xizangAfterBuild', { spaceName: space.name, houseLevel: space.houseLevel, ownerName: current.name, ownerColor: current.color });
  });

  socket.on('xizangDiceHigh', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!current.diceEffects) current.diceEffects = [];
    current.diceEffects.push({ min: 4, max: 6, tooltip: '下回合掷大点' });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}下回合掷大点(4-6)` });
  });

  socket.on('xizangDiceLow', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!current.diceEffects) current.diceEffects = [];
    current.diceEffects.push({ min: 1, max: 3, tooltip: '下回合掷小点' });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}下回合掷小点(1-3)` });
  });

  socket.on('xinjiangMove', (direction) => {
    if (!xinjiangMoveState || xinjiangMoveState.ownerSocketId !== socket.id) return;
    
    const owner = players.find(p => p.id === socket.id);
    if (!owner) return;
    
    if (direction === 'forward') {
      owner.position = (owner.position + 1) % BOARD_SIZE;
    } else if (direction === 'backward') {
      owner.position = owner.position === 0 ? BOARD_SIZE - 1 : owner.position - 1;
    }
    updateShelteredState();
    
    const { playerName, playerColor, ownerName, ownerColor, rent } = xinjiangMoveState;
    currentPlayerIndex = xinjiangMoveState.originalPlayerIndex;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('turnUpdate', { players, board, currentPlayerIndex, currentDiceValue });
    const moveText = direction === 'forward' ? '进1步' : direction === 'backward' ? '退1步' : '停留原地';
    io.emit('updateAreaE', { message: `${coloredName(ownerName, ownerColor)}通过丝绸之路${moveText}` });

    const originalPlayer = players[currentPlayerIndex];
    if (originalPlayer) {
      const originalSocket = io.sockets.sockets.get(originalPlayer.id);
      if (originalSocket) {
        originalSocket.emit('showEndTurn');
      }
    }
    
    xinjiangMoveState = null;
  });

  socket.on('xizangChoice', (choice) => {
    if (!xizangState || xizangState.ownerSocketId !== socket.id) return;
    
    const { playerName, playerColor, ownerName, ownerColor, rent, originalPlayerIndex } = xizangState;
    
    let diceText = '';
    const owner = players.find(p => p.id === socket.id);
    if (choice === 'high') {
      if (owner) {
        if (!owner.diceEffects) owner.diceEffects = [];
        owner.diceEffects.push({ min: 4, max: 6, tooltip: '下回合掷大点' });
      }
      diceText = '下回合掷大点(4-6)';
    } else if (choice === 'low') {
      if (owner) {
        if (!owner.diceEffects) owner.diceEffects = [];
        owner.diceEffects.push({ min: 1, max: 3, tooltip: '下回合掷小点' });
      }
      diceText = '下回合掷小点(1-3)';
    }
    
    currentPlayerIndex = originalPlayerIndex;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('turnUpdate', { players, board, currentPlayerIndex, currentDiceValue });
    if (diceText) {
      io.emit('updateAreaE', { message: `${coloredName(ownerName, ownerColor)}${diceText}` });
    }

    
    const originalPlayer = players[currentPlayerIndex];
    if (originalPlayer) {
      const originalSocket = io.sockets.sockets.get(originalPlayer.id);
      if (originalSocket) {
        originalSocket.emit('showEndTurn');
      }
    }
    
    xizangState = null;
  });

  socket.on('qinghaiHuyanChoice', (choice) => {
    if (!qinghaiState || qinghaiState.ownerSocketId !== socket.id) return;
    
    const { playerName, playerColor, ownerName, ownerColor, rent, originalPlayerIndex } = qinghaiState;
    const owner = players.find(p => p.id === socket.id);
    
    let clearedName = null;
    if (choice === 'clear' && owner) {
      // 随机清除一个状态
      clearedName = randomClearStatus(owner);
    }
    
    // 恢复到当前玩家
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    currentPlayerIndex = originalPlayerIndex;
    io.emit('turnUpdate', { players, board, currentPlayerIndex, currentDiceValue });
    
    // turnUpdate会覆盖E区消息，需要重新设置
    if (choice === 'clear' && clearedName) {
      io.emit('updateAreaE', { message: `${coloredName(ownerName, ownerColor)}用湖眼清除了${clearedName}` });
    } else {
      io.emit('updateAreaE', { message: `${coloredName(ownerName, ownerColor)}保留了自己的状态` });
    }
    
    // 地主清除F区
    const ownerSocket = io.sockets.sockets.get(owner.id);
    if (ownerSocket) ownerSocket.emit('clearAreaF');
    
    // 当前玩家F区显示结束
    const originalPlayer = players[currentPlayerIndex];
    if (originalPlayer) {
      const originalSocket = io.sockets.sockets.get(originalPlayer.id);
      if (originalSocket) originalSocket.emit('showEndTurn');
    }
    
    qinghaiState = null;
  });

  socket.on('guangxiBuildOwn', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.id === current.position);
    if (!space || space.name !== '广西') return;
    if (space.houseLevel >= 4) return;
    const buildCost = Math.round(space.price / 4);
    if (current.money < buildCost) return;
    previewMoney(current.id, -buildCost);
    space.houseLevel = (space.houseLevel || 0) + 1;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('guangxiAfterBuild', { spaceName: space.name, houseLevel: space.houseLevel, ownerName: current.name, ownerColor: current.color });
  });

  socket.on('guangxiSelectPlayer', (targetPlayerId) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!guangxiOwnState || guangxiOwnState.ownerId !== socket.id) return;
    const target = players.find(p => p.id === targetPlayerId);
    if (!target || target.id === current.id || target.bankrupt || target.sheltered) return;

    const continueGuangxi = (finalTarget, hiddenMsg) => {
      const t = finalTarget || target;
      if (t.id === current.id) {
        io.emit('updateAreaE', { message: `${hiddenMsg}交换取消` });
        socket.emit('showEndTurn');
        return;
      }
      const targetProperties = board.filter(s => s.owner === t.id && s.type === 'property' && s.isProperty);
      if (targetProperties.length === 0) {
        const space = board.find(s => s.id === current.position);
        const buildCost = space ? Math.round(space.price / 4) : 0;
        const houseLevel = space ? space.houseLevel : 0;
        socket.emit('guangxiNoProperty', { targetName: t.name, ownerName: current.name, ownerColor: current.color, buildCost, houseLevel });
        return;
      }
      guangxiOwnState.targetPlayerId = t.id;
      io.emit('updateAreaE', { message: `${hiddenMsg}请${coloredName(t.name, t.color)}选择地产交换广西` });
      const targetSocket = io.sockets.sockets.get(t.id);
      if (targetSocket) {
        targetSocket.emit('guangxiTargetChoice', {
          properties: targetProperties.map(p => ({ id: p.id, name: p.name })),
          ownerName: current.name,
          ownerColor: current.color,
          targetName: t.name,
          targetColor: t.color
        });
      }
    };

    const hiddenCard = target.cards?.find(c => c.hiddenType && ['quxiao', 'jianyuan', 'zhuanyi', 'fantan'].includes(c.hiddenType));
    if (hiddenCard) {
      checkHiddenCardTarget(target.id, current.id, (cancelled) => {
        if (cancelled) {
          socket.emit('showEndTurn');
          pendingHiddenResult = null;
          return;
        }
        let finalTarget = target;
        let hiddenMsg = '';
        if (pendingHiddenResult && pendingHiddenResult.message) {
          hiddenMsg = pendingHiddenResult.message + '，';
        }
        if (pendingHiddenResult && pendingHiddenResult.newTargetId) {
          const newTarget = players.find(p => p.id === pendingHiddenResult.newTargetId);
          if (newTarget) finalTarget = newTarget;
        }
        if (pendingHiddenResult && pendingHiddenResult.type === 'fantan') {
          finalTarget = current;
        }
        pendingHiddenResult = null;
        continueGuangxi(finalTarget, hiddenMsg);
      });
      return;
    }

    continueGuangxi(target, '');
  });

  socket.on('guangxiStartExchange', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    guangxiOwnState = { ownerId: socket.id };
  });

  socket.on('guangxiTargetExchange', (propertyId) => {
    if (!guangxiOwnState || guangxiOwnState.targetPlayerId !== socket.id) return;
    const { ownerId, targetPlayerId } = guangxiOwnState;
    const guangxiSpace = board.find(s => s.name === '广西');
    const exchangeSpace = board.find(s => s.id === propertyId);
    if (!guangxiSpace || !exchangeSpace) return;
    const tempOwner = guangxiSpace.owner;
    guangxiSpace.owner = exchangeSpace.owner;
    exchangeSpace.owner = tempOwner;
    guangxiSpace.houseLevel = 0;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    const owner = players.find(p => p.id === ownerId);
    const target = players.find(p => p.id === targetPlayerId);
    io.emit('updateAreaE', { message: `${coloredName(target.name, target.color)}用${exchangeSpace.name}与${coloredName(owner.name, owner.color)}交换了广西` });
    const ownerSocket = io.sockets.sockets.get(ownerId);
    if (ownerSocket) {
      ownerSocket.emit('guangxiExchangeDone');
    }
    guangxiOwnState = null;
  });

  socket.on('guangxiExchange', (propertyId) => {
    if (!guangxiState || guangxiState.originalPlayerId !== socket.id) return;
    
    const { ownerSocketId, playerName, playerColor, ownerName, ownerColor, guangxiId } = guangxiState;
    const guangxiSpace = board.find(s => s.id === guangxiId);
    const exchangeSpace = board.find(s => s.id === propertyId);
    
    if (guangxiSpace && exchangeSpace) {
      const oldGuangxiOwner = guangxiSpace.owner;
      const oldExchangeOwner = exchangeSpace.owner;
      guangxiSpace.owner = oldExchangeOwner;
      exchangeSpace.owner = oldGuangxiOwner;
      
      const doEnd = () => {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(playerName, playerColor)}用${exchangeSpace.name}与${coloredName(ownerName, ownerColor)}交换了广西` });
        socket.emit('showEndTurn');
        guangxiState = null;
      };

      const checkSecond = () => {
        doEnd();
      };

      if (oldGuangxiOwner) {
        checkSecond();
      } else {
        checkSecond();
      }
    } else {
      guangxiState = null;
    }
  });

  socket.on('changjiangAction', (transform) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    previewMoney(current.id, 9);
    let msg;
    if (transform) {
      const space = board.find(s => s.type === 'changjiang');
      if (space) space.name = '黄河';
      msg = `${coloredName(current.name, current.color)}污染了长江后进行了贸易，+9变黄河`;
    } else {
      msg = `${coloredName(current.name, current.color)}在长江进行了贸易，+9`;
    }
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: msg });
    socket.emit('showEndTurn');
  });

  socket.on('gaituReform', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.type === 'gaitu');
    if (!space || space.name === '改土') return;
    previewMoney(current.id, -7);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('gaituChoice');
  });

  socket.on('gaituSelect', ({ gaituName, immediate }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.type === 'gaitu');
    if (!space) return;
    space.name = gaituName;
    updateShelteredState();
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `已改造为${gaituName}` });
    io.emit('closeGaituPanel');
    if (immediate && gaituName !== '断桥') {
      executeGaituEffect(socket, current, gaituName);
    } else {
      socket.emit('showEndTurn');
    }
  });

  socket.on('gaituRobProperty', ({ propertyId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.id === propertyId);
    if (!space || !space.owner) return;
    const owner = players.find(p => p.id === space.owner);
    if (!owner) return;
    const rent = getRent(space);

    // 检查地产拥有者是否有保护卡
    if (owner.id !== current.id && owner.cards && owner.cards.some(c => c.name === '保护卡')) {
      baohuQueryState = {
        propertyId,
        ownerId: owner.id,
        currentPlayerId: current.id,
        source: 'gaitu',
        rent
      };
      const ownerSocket = io.sockets.sockets.get(owner.id);
      if (ownerSocket) {
        ownerSocket.emit('baohuQuery', { propertyName: space.name, currentPlayerName: current.name, currentPlayerColor: current.color });
      }
      // 广播给所有玩家，显示bottomBar图片覆盖
      io.emit('baohuOverlay', { targetPlayerId: owner.id, targetName: owner.name, targetColor: owner.color });
      io.emit('updateAreaE', { message: `等待${coloredName(owner.name, owner.color)}决定是否使用保护卡` });
      return;
    }

    const doRobbery = (pay) => {
      if (pay) {
        previewMoney(owner.id, -rent);
        previewMoney(current.id, rent);
      }
      space.closed = true;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}抢劫${coloredName(owner.name, owner.color)}路费${rent}，${space.name}停业` });
      io.emit('clearRobHighlight');
      socket.emit('showEndTurn');
    };
    doRobbery(true);
  });

  socket.on('gaituDiceHouseYes', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const activePlayers = players.filter(p => !p.bankrupt && !p.sheltered);
    activePlayers.forEach(p => {
      previewMoney(p.id, -10);
    });
    const diceResults = activePlayers.map(p => {
      const val = Math.floor(Math.random() * 6) + 1;
      if (!p.cards) p.cards = [];
      const card = cardData.find(c => c.id === 6 + val);
      if (card) addCardToPlayer(p, card);
      return { name: p.name, color: p.color, dice: val };
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    const diceMsg = diceResults.map(d => `${coloredName(d.name, d.color)}:骰子${d.dice}`).join(' ');
    io.emit('updateAreaE', { message: `所有人-10并获得骰子 ${diceMsg}` });
    socket.emit('showEndTurn');
  });

  socket.on('gaituGuanyinPray', ({ amount }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (amount <= 0) return;
    previewMoney(current.id, -amount);
    const roll = Math.floor(Math.random() * 6);
    const doJudge = () => {
      const newRoll = Math.floor(Math.random() * 6);
      io.emit('closeGaituPanel');
      if (newRoll === 0) {
        const reward = amount * 5;
        previewMoney(current.id, reward);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `大吉大利！${coloredName(current.name, current.color)}获得${reward}` });
      } else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `阿弥陀佛！${coloredName(current.name, current.color)}损失${amount}` });
      }
      socket.emit('showEndTurn');
    };
    const originalResult = () => {
      io.emit('closeGaituPanel');
      if (roll === 0) {
        const reward = amount * 5;
        previewMoney(current.id, reward);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `大吉大利！${coloredName(current.name, current.color)}获得${reward}` });
      } else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `阿弥陀佛！${coloredName(current.name, current.color)}损失${amount}` });
      }
      socket.emit('showEndTurn');
    };
    if (checkKoiOrDuogongnengJudge(current.id, doJudge, originalResult)) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `判定为${roll}，${roll === 0 ? '大吉' : '未中'}，是否重新判定？` });
      return;
    }
    io.emit('closeGaituPanel');
    if (roll === 0) {
      const reward = amount * 5;
      previewMoney(current.id, reward);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `大吉大利！${coloredName(current.name, current.color)}获得${reward}` });
    } else {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `阿弥陀佛！${coloredName(current.name, current.color)}损失${amount}` });
    }
    socket.emit('showEndTurn');
  });

  socket.on('gaituSwapPlayer', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id || target.sheltered) return;

    const doSwap = (p1, p2, hiddenMsg) => {
      if (p1.id === p2.id) {
        io.emit('updateAreaE', { message: `${hiddenMsg}换位取消` });
        const sourceSocket = io.sockets.sockets.get(current.id);
        if (sourceSocket) sourceSocket.emit('showEndTurn');
        return;
      }
      const tempPos = p1.position;
      p1.position = p2.position;
      p2.position = tempPos;
      const applyJailState = (player) => {
        if (player.position === JAIL_ISLAND_ID) {
          setPlayerState(player, 'inJail', true);
          player.jailState = 'island';
        } else if (player.position === JAIL_HOSPITAL_ID) {
          setPlayerState(player, 'inJail', true);
          player.jailState = 'hospital';
        } else if (player.position === JAIL_JAIL_ID) {
          if (returnDiamondIfHeld(player)) {
            io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
          }
          setPlayerState(player, 'inJail', true);
          player.jailState = 'jail';
        } else if (player.position === JAIL_FREE_ID) {
          setPlayerState(player, 'inJail', true);
          player.jailState = 'health';
        } else {
          player.inJail = false;
          player.jailState = null;
        }
      };
      applyJailState(p1);
      applyJailState(p2);
      updateShelteredState();
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(p1.name, p1.color)}与${coloredName(p2.name, p2.color)}互换了位置` });
      const sourceSocket = io.sockets.sockets.get(current.id);
      if (sourceSocket) sourceSocket.emit('showEndTurn');
    };

    const hiddenCard = target.cards?.find(c => c.hiddenType && ['quxiao', 'jianyuan', 'zhuanyi', 'fantan'].includes(c.hiddenType));
    if (hiddenCard) {
      checkHiddenCardTarget(target.id, current.id, (cancelled) => {
        if (cancelled) {
          socket.emit('showEndTurn');
          pendingHiddenResult = null;
          return;
        }
        let finalTarget = target;
        let hiddenMsg = '';
        if (pendingHiddenResult && pendingHiddenResult.message) {
          hiddenMsg = pendingHiddenResult.message + '，';
        }
        if (pendingHiddenResult && pendingHiddenResult.newTargetId) {
          const newTarget = players.find(p => p.id === pendingHiddenResult.newTargetId);
          if (newTarget && !newTarget.bankrupt && newTarget.id !== current.id && !newTarget.sheltered) finalTarget = newTarget;
        }
        if (pendingHiddenResult && pendingHiddenResult.type === 'fantan') {
          finalTarget = current;
        }
        pendingHiddenResult = null;
        doSwap(current, finalTarget, hiddenMsg);
      });
      return;
    }

    doSwap(current, target, '');
  });

  socket.on('gaituRouletteShoot', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.sheltered) return;

    const doShoot = (shootTarget, hiddenMsg) => {
      const totalPlayers = players.filter(p => !p.bankrupt).length;
      if (!rouletteRemaining) rouletteRemaining = totalPlayers;
      const roll = Math.floor(Math.random() * rouletteRemaining) + 1;
      const executeShoot = (finalRoll) => {
        if (finalRoll === 1) {
          previewMoney(shootTarget.id, -24);
          setPlayerState(shootTarget, 'inJail', true);
          shootTarget.jailState = 'hospital';
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `${hiddenMsg}判定为1，${coloredName(shootTarget.name, shootTarget.color)}中枪，-24并进医院` });
          rouletteRemaining = 0;
          rouletteTargets = [];
          socket.emit('showEndTurn');
        } else {
          rouletteTargets.push(shootTarget.id);
          rouletteRemaining -= 1;
          if (rouletteRemaining <= 1) {
            const lastTarget = players.find(p => !p.bankrupt && !p.sheltered && !rouletteTargets.includes(p.id));
            if (lastTarget) {
              previewMoney(lastTarget.id, -24);
              setPlayerState(lastTarget, 'inJail', true);
              lastTarget.jailState = 'hospital';
              io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
              io.emit('updateAreaE', { message: `${hiddenMsg}判定为${finalRoll}，只剩1人，${coloredName(lastTarget.name, lastTarget.color)}默认中枪，-24并进医院` });
            }
            rouletteRemaining = 0;
            rouletteTargets = [];
          } else {
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
            io.emit('updateAreaE', { message: `${hiddenMsg}判定为${finalRoll}，未击中，以后不可对${coloredName(shootTarget.name, shootTarget.color)}开枪` });
          }
          socket.emit('showEndTurn');
        }
      };
      const doRejudge = () => {
        const newRoll = Math.floor(Math.random() * rouletteRemaining) + 1;
        executeShoot(newRoll);
      };
      const originalShoot = () => {
        executeShoot(roll);
      };
      if (checkKoiOrDuogongnengJudge(current.id, doRejudge, originalShoot)) {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${hiddenMsg}判定为${roll}，${roll === 1 ? '中枪' : '未击中'}，是否重新判定？` });
        return;
      }
      executeShoot(roll);
    };

    const hiddenCard = target.cards?.find(c => c.hiddenType && ['quxiao', 'jianyuan', 'zhuanyi', 'fantan'].includes(c.hiddenType));
    if (hiddenCard) {
      checkHiddenCardTarget(target.id, current.id, (cancelled) => {
        if (cancelled) {
          socket.emit('showEndTurn');
          pendingHiddenResult = null;
          return;
        }
        let finalTarget = target;
        let hiddenMsg = '';
        if (pendingHiddenResult && pendingHiddenResult.message) {
          hiddenMsg = pendingHiddenResult.message + '，';
        }
        if (pendingHiddenResult && pendingHiddenResult.newTargetId) {
          const newTarget = players.find(p => p.id === pendingHiddenResult.newTargetId);
          if (newTarget && !newTarget.bankrupt && !newTarget.sheltered) finalTarget = newTarget;
        }
        if (pendingHiddenResult && pendingHiddenResult.type === 'fantan') {
          finalTarget = current;
        }
        pendingHiddenResult = null;
        doShoot(finalTarget, hiddenMsg);
      });
      return;
    }

    const totalPlayers = players.filter(p => !p.bankrupt).length;
    if (!rouletteRemaining) rouletteRemaining = totalPlayers;
    const roll = Math.floor(Math.random() * rouletteRemaining) + 1;
    const doJudge = () => {
      doShoot(target, '');
    };
    const originalResult = () => {
      if (roll === 1) {
        previewMoney(target.id, -24);
        setPlayerState(target, 'inJail', true);
        target.jailState = 'hospital';
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `判定为1，${coloredName(target.name, target.color)}中枪，-24并进医院` });
        rouletteRemaining = 0;
        rouletteTargets = [];
      } else {
        rouletteTargets.push(target.id);
        rouletteRemaining -= 1;
        if (rouletteRemaining <= 1) {
          const lastTarget = players.find(p => !p.bankrupt && !p.sheltered && !rouletteTargets.includes(p.id));
          if (lastTarget) {
            previewMoney(lastTarget.id, -24);
            setPlayerState(lastTarget, 'inJail', true);
            lastTarget.jailState = 'hospital';
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
            io.emit('updateAreaE', { message: `判定为${roll}，只剩1人，${coloredName(lastTarget.name, lastTarget.color)}默认中枪，-24并进医院` });
          }
          rouletteRemaining = 0;
          rouletteTargets = [];
        } else {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `判定为${roll}，未击中，以后不可对${coloredName(target.name, target.color)}开枪` });
        }
      }
      socket.emit('showEndTurn');
    };
    if (checkKoiOrDuogongnengJudge(current.id, doJudge, originalResult)) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `判定为${roll}，${roll === 1 ? '中枪' : '未击中'}，是否重新判定？` });
      return;
    }
    doShoot(target, '');
  });

  socket.on('dayunPlace', ({ spaceId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const allowedIds = [5, 11, 17, 23, 29, 35];
    if (!allowedIds.includes(spaceId)) return;
    dayunState = { playerId: current.id, position: spaceId, active: true };
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, dayunState });
    io.emit('updateAreaE', { message: '大运车下回合经过的人-4休息1回合，到达的人-8进医院' });
    socket.emit('showEndTurn');
  });

  socket.on('guoneiLvyouSelect', ({ spaceId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const allowedIds = [8, 9, 10];
    if (!allowedIds.includes(spaceId)) return;
    current.position = spaceId;
    qiyuState = null;
    const space = board.find(s => s.id === spaceId);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}到${space.name}` });
    socket.emit('showEndTurn');
  });

  socket.on('zagumaitieSelectProperty', ({ spaceId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const property = board.find(s => s.id === spaceId);
    if (!property || property.owner !== current.id) return;
    qiyuState = { type: 'zagumaitie', selectedProperty: property };
    socket.emit('zagumaitieShowOptions', { propertyId: property.id, propertyName: property.name });
  });

  socket.on('zagumaitieSellToBank', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.type !== 'zagumaitie' || !qiyuState.selectedProperty) return;
    const property = qiyuState.selectedProperty;
    if (checkProtectedAsset(current.id, 'property')) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的保护卡生效，${property.name}免于拍卖` });
      socket.emit('showEndTurn');
      qiyuState = null;
      return;
    }
    const price = propertyData.find(p => p[0] === property.name)?.[1]?.[0] || 20;
    const gain = Math.floor(price / 2);
    property.owner = 'bank';
    property.houses = 0;
    previewMoney(current.id, gain);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}拍卖${property.name}给银行+${gain}` });
    socket.emit('showEndTurn');
    qiyuState = null;
  });

  socket.on('zagumaitieSellToPlayer', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.type !== 'zagumaitie' || !qiyuState.selectedProperty) return;
    const property = qiyuState.selectedProperty;
    if (checkProtectedAsset(current.id, 'property')) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的保护卡生效，${property.name}免于拍卖` });
      socket.emit('showEndTurn');
      qiyuState = null;
      return;
    }
    const activePlayers = players.filter(p => !p.bankrupt && p.id !== current.id);
    if (activePlayers.length === 0) {
      io.emit('updateAreaE', { message: `砸锅卖铁:没有其他玩家可竞拍` });
      socket.emit('showEndTurn');
      qiyuState = null;
      return;
    }
    property.owner = null;
    auctionState = {
      propertyId: property.id,
      bids: {},
      passedPlayers: [],
      currentBidderIndex: 0,
      activePlayers: activePlayers.map(p => p.id),
      currentBid: 0,
      roundStartBid: 0,
      lastBidderId: null,
      isPetAuction: false,
      isPropertyAuction: true,
      sellerId: current.id,
      sellerName: current.name,
      sellerColor: current.color
    };
    qiyuState = { type: 'zagumaitie_auction', property: property, sellerId: current.id };
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('propertyAuctionStart', {
      property: { id: property.id, name: property.name, price: property.price },
      currentBidderId: activePlayers[0].id,
      currentBidderName: activePlayers[0].name,
      currentBidderColor: activePlayers[0].color
    });
  });

  socket.on('huangheAction', (transform) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    previewMoney(current.id, -10);
    let msg;
    if (transform) {
      const space = board.find(s => s.type === 'changjiang');
      if (space) space.name = '长江';
      msg = `${coloredName(current.name, current.color)}治理了黄河，-10变长江`;
    } else {
      msg = `黄河冲垮了良田，${coloredName(current.name, current.color)}-10`;
    }
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: msg });
    socket.emit('showEndTurn');
  });

  socket.on('lianhenAction', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const hezongPlayers = players.filter(p => p.id !== current.id && !p.bankrupt && (p.hezongState === 'forced' || p.hezongState === 'normal'));
    if (hezongPlayers.length > 0) {
      let totalGain = 0;
      hezongPlayers.forEach(p => {
        p.hezongState = null;
        p.hezongTurns = 0;
        p.hezongTarget = null;
        previewMoney(p.id, -7);
        totalGain += 7;
      });
      previewMoney(current.id, totalGain);
      const names = hezongPlayers.map(p => coloredName(p.name, p.color)).join('、');
      const msg = `${coloredName(current.name, current.color)}令合纵瓦解，掠夺${names}${totalGain}`;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: msg });
      socket.emit('showEndTurn');
    } else {
      let totalGain = 0;
      players.forEach(p => {
        if (p.id !== current.id && !p.bankrupt && !p.sheltered) {
          previewMoney(p.id, -3);
          totalGain += 3;
        }
      });
      previewMoney(current.id, totalGain);
      const msg = `${coloredName(current.name, current.color)}连横，从每人掠夺3`;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: msg });
      socket.emit('showEndTurn');
    }
  });

  socket.on('hezongJoin', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const hezongSpace = board.find(s => s.type === 'hezong');
    const hezongPos = hezongSpace ? hezongSpace.id : 30;
    const existingHezong = players.find(p => p.id !== current.id && p.position === hezongPos && (p.hezongState === 'forced' || p.hezongState === 'normal'));
    if (existingHezong) {
      hezongFirstPlayerId = existingHezong.id;
      current.hezongState = 'normal';
      current.hezongTurns = 0;
      current.position = hezongPos;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      // 合纵玩家可以选对方作为目标，所以不排除合纵玩家自己
      const hezongPlayerIds = [current.id, existingHezong.id];
      const allPlayers = players.filter(p => !p.bankrupt && !p.sheltered);
      const allPlayersData = allPlayers.map(p => ({ id: p.id, name: p.name, color: p.color }));
      if (allPlayersData.length === 0) {
        io.emit('noValidTarget');
        return;
      }
      io.emit('updateAreaE', { message: `合纵即将成功，请选择目标` });
      io.to(existingHezong.id).emit('hezongSelectTarget', { otherPlayers: allPlayersData, hezongPlayerIds });
      socket.emit('hezongSelectTarget', { otherPlayers: allPlayersData, hezongPlayerIds });
    } else {
      current.hezongState = 'forced';
      current.hezongTurns = 2;
      current.position = hezongPos;
      const msg = `停留此处至少2回合，之后可继续停留2回合`;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: msg });
      socket.emit('showEndTurn');
    }
  });

  socket.on('hezongJoinAlliance', (hezongPlayerId) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const hezongPlayer = players.find(p => p.id === hezongPlayerId && (p.hezongState === 'forced' || p.hezongState === 'normal'));
    if (!hezongPlayer) return;
    
    hezongFirstPlayerId = hezongPlayer.id;
    current.hezongState = 'normal';
    const hezongSpace = board.find(s => s.type === 'hezong');
    current.position = hezongSpace ? hezongSpace.id : 30;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    
    // 合纵玩家可以选对方作为目标，所以不排除合纵玩家自己
    const hezongPlayerIds = [current.id, hezongPlayer.id];
    const allPlayers = players.filter(p => !p.bankrupt && !p.sheltered);
    const allPlayersData = allPlayers.map(p => ({ id: p.id, name: p.name, color: p.color }));
    if (allPlayersData.length === 0) {
      io.emit('noValidTarget');
      return;
    }
    io.to(hezongPlayer.id).emit('hezongSelectTarget', { otherPlayers: allPlayersData, hezongPlayerIds });
    socket.emit('hezongSelectTarget', { otherPlayers: allPlayersData, hezongPlayerIds });
  });

  socket.on('hezongAlliance', (targetId) => {
    const sender = players.find(p => p.id === socket.id);
    if (!sender) return;
    
    const hezongSpace = board.find(s => s.type === 'hezong');
    const hezongPos = hezongSpace ? hezongSpace.id : 30;
    const hezongPlayers = players.filter(p => p.position === hezongPos && (p.hezongState === 'forced' || p.hezongState === 'normal'));
    if (hezongPlayers.length !== 2) return;
    
    const isHezongPlayer = hezongPlayers.some(p => p.id === socket.id);
    if (!isHezongPlayer) return;
    
    sender.hezongTarget = targetId;
    
    const otherHezongPlayer = hezongPlayers.find(p => p.id !== socket.id);
    
    if (otherHezongPlayer.hezongTarget && sender.hezongTarget) {
      if (otherHezongPlayer.hezongTarget === sender.hezongTarget) {
        const target = players.find(p => p.id === targetId);
        if (target) {
          const isHezongTarget = hezongPlayers.some(p => p.id === targetId);
          if (isHezongTarget) {
            // 目标是合纵玩家自己（不应发生，因为已排除）
            const otherHz = hezongPlayers.find(p => p.id !== targetId);
            const firstHz = players.find(p => p.id === hezongFirstPlayerId);
            deductMoney(targetId, 7);
            previewMoney(otherHz.id, 7);
            if (firstHz) firstHz.salary += 3;
            hezongPlayers.forEach(p => { p.hezongState = null; p.hezongTurns = 0; p.hezongTarget = null; });
            const msg = `合纵成功，${coloredName(target.name, target.color)}给${coloredName(otherHz.name, otherHz.color)}7，${coloredName(firstHz ? firstHz.name : otherHz.name, firstHz ? firstHz.color : otherHz.color)}工资+3`;
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
            io.emit('hezongResult', { success: true, msg });
            // 给当前回合玩家发送结束回合
            const currentPlayer = players[currentPlayerIndex];
            if (currentPlayer) {
              const currentSocket = io.sockets.sockets.get(currentPlayer.id);
              if (currentSocket) currentSocket.emit('showEndTurn');
            }
          } else {
            const doHezongLoss = (pay) => {
              hezongPlayers.forEach(p => { p.hezongState = null; p.hezongTurns = 0; p.hezongTarget = null; });
              if (pay) {
                deductMoney(target.id, 14);
                previewMoney(sender.id, 7);
                previewMoney(otherHezongPlayer.id, 7);
                const firstHz = players.find(p => p.id === hezongFirstPlayerId);
                if (firstHz) firstHz.salary += 3;
                const msg = `合纵成功，${coloredName(target.name, target.color)}给两名合纵每人7，${coloredName(firstHz ? firstHz.name : otherHezongPlayer.name, firstHz ? firstHz.color : otherHezongPlayer.color)}工资+3`;
                io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
                io.emit('hezongResult', { success: true, msg });
              } else {
                io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
                io.emit('hezongResult', { success: true, msg: `${coloredName(target.name, target.color)}失去的钱＞10，保护卡令其无效` });
              }
              // 给当前回合玩家发送结束回合
              const currentPlayer = players[currentPlayerIndex];
              if (currentPlayer) {
                const currentSocket = io.sockets.sockets.get(currentPlayer.id);
                if (currentSocket) currentSocket.emit('showEndTurn');
              }
            };
            doHezongLoss(true);
          }
        }
      } else {
        const senderTargetId = sender.hezongTarget;
        const otherTargetId = otherHezongPlayer.hezongTarget;
        otherHezongPlayer.hezongState = null;
        otherHezongPlayer.hezongTurns = 0;
        otherHezongPlayer.hezongTarget = null;
        sender.hezongState = null;
        sender.hezongTarget = null;
        const senderTarget = players.find(p => p.id === senderTargetId);
        const otherTarget = players.find(p => p.id === otherTargetId);
        const msg = `${coloredName(sender.name, sender.color)}→${coloredName(senderTarget?.name || '未知', senderTarget?.color || '#fff')}，${coloredName(otherHezongPlayer.name, otherHezongPlayer.color)}→${coloredName(otherTarget?.name || '未知', otherTarget?.color || '#fff')}，目标不一致，合纵失败`;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('hezongFail', msg);
        const currentPlayer = players[currentPlayerIndex];
        if (currentPlayer) {
          const currentSocket = io.sockets.sockets.get(currentPlayer.id);
          if (currentSocket) currentSocket.emit('showEndTurn');
        }
      }
    }
  });

  socket.on('hezongBreak', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const hezongSpace2 = board.find(s => s.type === 'hezong');
    const hezongPos2 = hezongSpace2 ? hezongSpace2.id : 30;
    const hezongPlayer = players.find(p => p.id !== current.id && p.position === hezongPos2 && (p.hezongState === 'forced' || p.hezongState === 'normal'));
    if (!hezongPlayer) return;
    previewMoney(hezongPlayer.id, -7);
    previewMoney(current.id, 7);
    hezongPlayer.hezongState = null;
    hezongPlayer.hezongTurns = 0;
    hezongPlayer.hezongTarget = null;
    const msg = `合纵瓦解，${coloredName(hezongPlayer.name, hezongPlayer.color)}给${coloredName(current.name, current.color)}7`;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: msg });
    socket.emit('showEndTurn');
  });

  socket.on('hezongLeave', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    current.hezongState = null;
    current.hezongTurns = 0;
    current.hezongTarget = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('turnUpdate', { players, board, currentPlayerIndex, currentDiceValue });
  });

  socket.on('kunlunSelect', ({ option }) => {
    if (!kunlunState || kunlunState.playerId !== socket.id) return;
    const kunlunPlayer = players.find(p => p.id === kunlunState.playerId);
    if (!kunlunPlayer) return;

    // 先关闭所有人的昆仑TCK面板和B区覆盖
    io.emit('closeKunlunTck');
    io.emit('bAreaOverlayClose');

    const finishKunlun = () => {
      kunlunState.progress = 0;
      io.emit('kunlunNewCycle', { playerId: kunlunPlayer.id, progress: 0 });
      io.emit('kunlunStartTurn', { playerId: kunlunPlayer.id });
      if (kunlunFromTurn) {
        const currentSocket = io.sockets.sockets.get(kunlunPlayer.id);
        if (currentSocket) currentSocket.emit('showEndTurn');
      } else {
        // 非回合触发，选择完毕后继续当前回合流程
        startCurrentTurn();
      }
      kunlunFromTurn = false;
    };

    if (option === '工资+1') {
      kunlunPlayer.salary += 1;
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    } else if (option === '+6') {
      previewMoney(kunlunPlayer.id, 6);
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    } else if (option === '每人给你2') {
      players.forEach(p => {
        if (p.id !== kunlunPlayer.id && !p.bankrupt) {
          previewMoney(p.id, -2);
          previewMoney(kunlunPlayer.id, 2);
        }
      });
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    } else if (option === '解冻') {
      if (kunlunPlayer.frozen > 0) {
        previewMoney(kunlunPlayer.id, kunlunPlayer.frozen);
        kunlunPlayer.frozen = 0;
      }
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    } else if (option === '免休卡+1') {
      const mianxiuka = cardData.find(c => c.id === 5);
      if (mianxiuka) {
        if (!kunlunPlayer.cards) kunlunPlayer.cards = [];
        addCardToPlayer(kunlunPlayer, mianxiuka);
      }
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    } else if (option === '骰子+1') {
      const diceValue = Math.floor(Math.random() * 6) + 1;
      const diceCard = cardData.find(c => c.id === 6 + diceValue);
      if (diceCard) {
        if (!kunlunPlayer.cards) kunlunPlayer.cards = [];
        addCardToPlayer(kunlunPlayer, diceCard);
      }
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    } else if (option === '再动一次') {
      if (!kunlunPlayer.extraTurns) kunlunPlayer.extraTurns = 0;
      kunlunPlayer.extraTurns += 1;
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    } else if (option === '+5') {
      previewMoney(kunlunPlayer.id, 5);
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    } else if (option === '+4') {
      previewMoney(kunlunPlayer.id, 4);
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    } else if (option === '+3') {
      previewMoney(kunlunPlayer.id, 3);
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    } else if (option === '每人给你3') {
      players.forEach(p => {
        if (p.id !== kunlunPlayer.id && !p.bankrupt) {
          previewMoney(p.id, -3);
          previewMoney(kunlunPlayer.id, 3);
        }
      });
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    } else if (option === '工资+2') {
      kunlunPlayer.salary += 2;
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    } else if (option === '昆仑之门【需钥匙】：+40') {
      const doKeyReward = () => {
        previewMoney(kunlunPlayer.id, 40);
        io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        finishKunlun();
      };
      if (triggerYaoshi(kunlunPlayer.id, '昆仑之门：+40', '+40', doKeyReward)) {
      } else {
        return;
      }
    } else if (option === '随机移除自己1项状态') {
      const removableStatuses = [];
      if (kunlunPlayer.extraTurns > 0) removableStatuses.push('extraTurns');
      if (kunlunPlayer.fuwufeiExtraMove) removableStatuses.push('fuwufeiExtraMove');
      if (kunlunPlayer.restTurns > 0) removableStatuses.push('restTurns');
      if (kunlunPlayer.sheltered) removableStatuses.push('sheltered');
      if (kunlunPlayer.shihua) removableStatuses.push('shihua');
      if (kunlunPlayer.guhuoDice) removableStatuses.push('guhuoDice');
      if (kunlunPlayer.shoumaiDice) removableStatuses.push('shoumaiDice');
      if (kunlunPlayer.yinyueDice) removableStatuses.push('yinyueDice');
      if (kunlunPlayer.shijieWar) removableStatuses.push('shijieWar');
      if (kunlunPlayer.hezongState === 'forced' || kunlunPlayer.hezongState === 'normal') removableStatuses.push('hezongState');
      if (kunlunPlayer.diceEffects && kunlunPlayer.diceEffects.length > 0) removableStatuses.push('diceEffects');
      if (kunlunPlayer.daotui) removableStatuses.push('daotui');
      if (kunlunPlayer.bingdong > 0) removableStatuses.push('bingdong');
      if (kunlunPlayer.bomingFrozen) removableStatuses.push('bomingFrozen');
      if (kunlunPlayer.jinzu) removableStatuses.push('jinzu');
      if (kunlunPlayer.tuolei && kunlunPlayer.tuolei.turns > 0) removableStatuses.push('tuolei');
      if (kunlunPlayer.wenjigifwu) removableStatuses.push('wenjigifwu');
      if (kunlunPlayer.dizhuTurns > 0) removableStatuses.push('dizhuTurns');
      if (kunlunPlayer.fengkongDice && kunlunPlayer.fengkongDice.length > 0) removableStatuses.push('fengkongDice');
      if (kunlunPlayer.syncedDice) removableStatuses.push('syncedDice');
      if (kunlunPlayer.cunqianList && kunlunPlayer.cunqianList.length > 0) removableStatuses.push('cunqianList');
      if (kunlunPlayer.inJail) removableStatuses.push('inJail');

      if (removableStatuses.length === 0) {
        return;
      }

      const removed = removableStatuses[Math.floor(Math.random() * removableStatuses.length)];
      switch (removed) {
        case 'extraTurns': kunlunPlayer.extraTurns = 0; break;
        case 'fuwufeiExtraMove': kunlunPlayer.fuwufeiExtraMove = false; break;
        case 'restTurns': kunlunPlayer.restTurns = 0; break;
        case 'sheltered': kunlunPlayer.sheltered = false; kunlunPlayer.shelteredTurns = 0; break;
        case 'shihua': kunlunPlayer.shihua = false; break;
        case 'guhuoDice': kunlunPlayer.guhuoDice = null; kunlunPlayer.guhuoBy = null; break;
        case 'shoumaiDice': kunlunPlayer.shoumaiDice = null; break;
        case 'yinyueDice': kunlunPlayer.yinyueDice = null; kunlunPlayer.yinyueBy = null; break;
        case 'shijieWar': kunlunPlayer.shijieWar = false; break;
        case 'hezongState': kunlunPlayer.hezongState = null; kunlunPlayer.hezongTurns = 0; kunlunPlayer.hezongTarget = null; break;
        case 'diceEffects': kunlunPlayer.diceEffects = []; break;
        case 'daotui': kunlunPlayer.daotui = false; break;
        case 'bingdong': kunlunPlayer.bingdong = 0; break;
        case 'bomingFrozen': kunlunPlayer.bomingFrozen = false; break;
        case 'jinzu': kunlunPlayer.jinzu = false; break;
        case 'tuolei': kunlunPlayer.tuolei = null; break;
        case 'wenjigifwu': kunlunPlayer.wenjigifwu = false; break;
        case 'dizhuTurns': kunlunPlayer.dizhuTurns = 0; break;
        case 'fengkongDice': kunlunPlayer.fengkongDice = []; break;
        case 'syncedDice': kunlunPlayer.syncedDice = null; kunlunPlayer.syncedByName = null; break;
        case 'cunqianList': kunlunPlayer.cunqianList = []; break;
        case 'inJail': kunlunPlayer.inJail = false; kunlunPlayer.jailState = null; kunlunPlayer.position = 1; break;
      }

      const removedNames = {
        extraTurns: '再动次数', fuwufeiExtraMove: '服务费再动', restTurns: '休息',
        sheltered: '避难', shihua: '石化', guhuoDice: '蛊惑骰子',
        shoumaiDice: '受卖骰子', yinyueDice: '音乐指挥骰子', shijieWar: '世界大战',
        hezongState: '合纵', diceEffects: '骰子效果', daotui: '倒退',
        bingdong: '冰冻', bomingFrozen: '搏命冻结', jinzu: '禁足',
        tuolei: '拖累', wenjigifwu: '闻鸡起舞', dizhuTurns: '地主',
        fengkongDice: '封控骰子', syncedDice: '同步骰子', cunqianList: '存钱',
        inJail: '囚牢'
      };
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option: `随机移除：${removedNames[removed] || removed}` });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    } else if (option === '临时金钱+10') {
      grantTempMoney(kunlunPlayer.id, 10, 3);
      io.emit('kunlunResult', { playerId: kunlunPlayer.id, playerName: kunlunPlayer.name, playerColor: kunlunPlayer.color, option });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      finishKunlun();
    }
  });

  socket.on('kunlunDiceSelect', ({ diceValue }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!kunlunState || !kunlunState.waitingDiceChoice) return;

    currentDiceValue = diceValue;
    const fromPos = current.position;
    const newPos = (current.position + diceValue) % 36;
    
    kunlunState.progress = 0;
    kunlunState.waitingDiceChoice = false;


    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });

    io.emit('kunlunNewCycle', { playerId: current.id, progress: 0 });
    
    io.emit('diceResult', { playerId: current.id, fromPos, dice: diceValue, newPos });
    diceAnimState = { playerId: current.id, fromPos, dice: diceValue, newPos };
  });

  socket.on('kunlunPropertySelectDone', ({ propertyId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!kunlunState || !kunlunState.waitingPropertySelect) return;

    const space = board.find(s => s.id === propertyId);
    if (space) {
      space.rent = (space.rent || 0) + 2;

      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });

    }
    kunlunState.progress = 0;
    kunlunState.waitingPropertySelect = false;
    io.emit('kunlunNewCycle', { playerId: current.id, progress: 0 });
    io.emit('kunlunStartTurn', { playerId: current.id });
  });

  socket.on('sansiSelect', ({ option }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!sansiState || sansiState.playerId !== current.id || sansiState.phase !== 'select') return;

    const remaining = sansiState.options.filter(o => o !== option);

    if (option === '随机飞' && !current.inJail) {
      const fromPos = current.position;
      const targetPos = Math.floor(Math.random() * BOARD_SIZE);
      let steps = targetPos - fromPos;
      if (steps <= 0) steps += BOARD_SIZE;
      current.position = targetPos;
      sansiState.selectedOption = option;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'select';
      io.emit('diceResult', { playerId: current.id, fromPos, dice: steps, newPos: targetPos, teleport: true });
      diceAnimState = { playerId: current.id, fromPos, dice: steps, newPos: targetPos };
      sansiState.pendingAnim = true;
      return;
    }

    if (option === '+5，后退5步' && !current.inJail) {
      const fromPos = current.position;
      let newPos = fromPos - 5;
      if (newPos < 0) newPos += BOARD_SIZE;
      current.position = newPos;
      previewMoney(current.id, 5);
      sansiState.selectedOption = option;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'select';
      io.emit('diceResult', { playerId: current.id, fromPos, dice: 5, newPos, direction: 'backward' });
      diceAnimState = { playerId: current.id, fromPos, dice: 5, newPos };
      sansiState.pendingAnim = true;
      return;
    }

    if (option === '解冻，后退3步' && !current.inJail) {
      const fromPos = current.position;
      let newPos = fromPos - 3;
      if (newPos < 0) newPos += BOARD_SIZE;
      current.position = newPos;
      if (current.frozen > 0) {
        previewMoney(current.id, current.frozen);
        current.frozen = 0;
      }
      sansiState.selectedOption = option;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'select';
      io.emit('diceResult', { playerId: current.id, fromPos, dice: 3, newPos, direction: 'backward' });
      diceAnimState = { playerId: current.id, fromPos, dice: 3, newPos };
      sansiState.pendingAnim = true;
      return;
    }

    if (option === '倒退卡+1，后退7步' && !current.inJail) {
      const fromPos = current.position;
      let newPos = fromPos - 7;
      if (newPos < 0) newPos += BOARD_SIZE;
      current.position = newPos;
      const backCard = cardData.find(c => c.id === 16);
      if (backCard) {
        if (!current.cards) current.cards = [];
        addCardToPlayer(current, backCard);
      }
      sansiState.selectedOption = option;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'select';
      io.emit('diceResult', { playerId: current.id, fromPos, dice: 7, newPos, direction: 'backward' });
      diceAnimState = { playerId: current.id, fromPos, dice: 7, newPos };
      sansiState.pendingAnim = true;
      return;
    }

    if (option === '前进1步，给地产最少的6' && !current.inJail) {
      const fromPos = current.position;
      const newPos = (fromPos + 1) % BOARD_SIZE;
      current.position = newPos;
      current.money -= 6;
      const ap = players.filter(p => !p.bankrupt);
      let minProps = Infinity;
      let candidates = [];
      for (const p of ap) {
        const propCount = board.filter(s => s.isProperty && s.owner === p.id).length;
        if (propCount < minProps) { minProps = propCount; candidates = [p]; }
        else if (propCount === minProps) candidates.push(p);
      }
      if (candidates.length > 0) {
        const recipient = candidates[Math.floor(Math.random() * candidates.length)];
        recipient.money += 6;
      }
      sansiState.selectedOption = option;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'select';
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('diceResult', { playerId: current.id, fromPos, dice: 1, newPos });
      diceAnimState = { playerId: current.id, fromPos, dice: 1, newPos };
      sansiState.pendingAnim = true;
      return;
    }

    if (option === '前进7步，休息1回合' && !current.inJail) {
      const fromPos = current.position;
      const newPos = (fromPos + 7) % BOARD_SIZE;
      current.position = newPos;
      applyRest(current.id, 1, `${coloredName(current.name, current.color)}前进7步，休息1回合`, socket);
      sansiState.selectedOption = option;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'select';
      io.emit('diceResult', { playerId: current.id, fromPos, dice: 7, newPos });
      diceAnimState = { playerId: current.id, fromPos, dice: 7, newPos };
      sansiState.pendingAnim = true;
      return;
    }

    if (option === '每人给你3，后退5步' && !current.inJail) {
      players.forEach(p => {
        if (p.id !== current.id && !p.bankrupt) {
          p.money -= 3;
          current.money += 3;
        }
      });
      const fromPos = current.position;
      const newPos = (fromPos - 5 + BOARD_SIZE) % BOARD_SIZE;
      current.position = newPos;
      sansiState.selectedOption = option;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'select';
      io.emit('diceResult', { playerId: current.id, fromPos, dice: 5, newPos, direction: 'backward' });
      diceAnimState = { playerId: current.id, fromPos, dice: 5, newPos };
      sansiState.pendingAnim = true;
      return;
    }

    // -38，随机获得空地
    if (option === '-38，随机获得空地') {
      const emptyProps = board.filter(s => s.isProperty && !s.owner);
      let optionDisplay = option;
      if (emptyProps.length === 0) {
        optionDisplay = `${option}（没有合适的空地）`;
        io.emit('updateAreaE', { message: '没有合适的空地' });
      } else {
        previewMoney(current.id, -38);
        const targetProp = emptyProps[Math.floor(Math.random() * emptyProps.length)];
        targetProp.owner = current.id;
        optionDisplay = `${option}（${targetProp.name}）`;
      }
      sansiState.selectedOption = optionDisplay;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'selectTarget';
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option: optionDisplay, remaining, targetMsg: '' });
      return;
    }

    // 休息2回合，随机2个他人地产停业
    if (option === '休息2回合，随机2个他人地产停业') {
      const otherProps = board.filter(s => s.isProperty && s.owner && s.owner !== current.id && !players.find(p => p.id === s.owner)?.bankrupt);
      let optionDisplay = option;
      if (otherProps.length === 0) {
        optionDisplay = `${option}（没有合适的地产）`;
        io.emit('updateAreaE', { message: '没有合适的地产' });
      } else {
        applyRest(current.id, 2, `${coloredName(current.name, current.color)}休息2回合，随机他人地产停业`, null, null, { skipShowEndTurn: true });
        const shuffled = otherProps.sort(() => Math.random() - 0.5);
        const toClose = shuffled.slice(0, Math.min(2, shuffled.length));
        toClose.forEach(prop => { prop.closed = true; });
        optionDisplay = `${option}（${toClose.length}块地产停业）`;
      }
      sansiState.selectedOption = optionDisplay;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'selectTarget';
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option: optionDisplay, remaining, targetMsg: '' });
      return;
    }

    // -10，获得随机1张卡片
    if (option === '-10，获得随机1张卡片') {
      previewMoney(current.id, -10);
      const card = getRandomCard();
      if (card) {
        if (!current.cards) current.cards = [];
        addCardToPlayer(current, card);
      }
      sansiState.selectedOption = `${option}${card ? `（${card.name}）` : ''}`;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'selectTarget';
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option: `${option}${card ? `（${card.name}）` : ''}`, remaining, targetMsg: '' });
      return;
    }

    // -7
    if (option === '-7') {
      previewMoney(current.id, -7);
      sansiState.selectedOption = option;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'selectTarget';
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option, remaining, targetMsg: '' });
      return;
    }

    // 上家-4，下家-3
    if (option === '上家-4，下家-3') {
      const alive = players.filter(p => !p.bankrupt);
      const ci = alive.findIndex(p => p.id === current.id);
      const prevP = alive[(ci - 1 + alive.length) % alive.length];
      const nextP = alive[(ci + 1) % alive.length];
      previewMoney(prevP.id, -4);
      previewMoney(nextP.id, -3);
      sansiState.selectedOption = option;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'selectTarget';
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option, remaining, targetMsg: '' });
      return;
    }

    // 到起点
    if (option === '到起点') {
      if (current.inJail) { current.inJail = false; current.jailState = null; }
      current.position = 0;
      sansiState.selectedOption = option;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'selectTarget';
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option, remaining, targetMsg: '' });
      return;
    }

    sansiState.selectedOption = option;
    sansiState.remainingOptions = remaining;

    const result = executeSansiOption(current, option, socket);

    if (result && result.type === 'noAsset') {
      sansiState.phase = 'selectTarget';
      const validTargets = players.filter(p => !p.bankrupt && p.id !== current.id);
      if (validTargets.length === 0) {
        sansiState = null;
        io.emit('noValidTarget');
        return;
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option, remaining, targetMsg: '' });
      io.emit('updateAreaE', { message: `没有${result.assetType}执行，请选目标` });
      return;
    }

    if (result && result.noProperty) {
      sansiState.phase = 'selectTarget';
      const validTargets = players.filter(p => !p.bankrupt && p.id !== current.id);
      if (validTargets.length === 0) { sansiState = null; io.emit('noValidTarget'); return; }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option, remaining, targetMsg: '' });
      io.emit('updateAreaE', { message: '没有合适的地产' });
      return;
    }

    if (result && result.type === 'noKey') {
      sansiState.phase = 'selectTarget';
      const validTargets = players.filter(p => !p.bankrupt && p.id !== current.id);
      if (validTargets.length === 0) {
        sansiState = null;
        io.emit('noValidTarget');
        return;
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option, remaining, targetMsg: '' });
      io.emit('updateAreaE', { message: '没有钥匙，请选目标' });
      return;
    }

    if (result && result.type === 'removedStatus') {
      sansiState.phase = 'selectTarget';
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option: `随机移除：${result.removedName}`, remaining });
      return;
    }

    if (result && result.type === 'targetInfo') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiComplete', { playerId: current.id, playerName: current.name, playerColor: current.color, option });
      sansiState = null;
      return;
    }

    if (result && result.randomPropName) {
      const displayOption = `${option}（${result.randomPropName}）`;
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}选择了${displayOption}` });
      sansiState.phase = 'selectTarget';
      const validTargets = players.filter(p => !p.bankrupt && p.id !== current.id);
      if (validTargets.length === 0) { sansiState = null; io.emit('noValidTarget'); return; }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option: displayOption, remaining, targetMsg: '' });
      return;
    }

    if (option === '到昆仑被仙人赐福，-12') {
      if (current.inJail) { current.inJail = false; current.jailState = null; }
      current.position = 6;
      current.money -= 12;
      if (kunlunState && kunlunState.playerId !== current.id) {
        kunlunState = { playerId: current.id, playerName: current.name, playerColor: current.color, progress: 0 };
      }
      if (!kunlunState) {
        kunlunState = { playerId: current.id, playerName: current.name, playerColor: current.color, progress: 0 };
      }
      sansiState.selectedOption = option;
      sansiState.remainingOptions = remaining;
      sansiState.phase = 'selectTarget';
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option, remaining });
      io.emit('kunlunArrive', { playerId: current.id, playerName: current.name, playerColor: current.color, progress: kunlunState.progress });
      return;
    }

    sansiState.phase = 'selectTarget';

    const validTargets = players.filter(p => !p.bankrupt && p.id !== current.id);
    if (validTargets.length === 0) {
      sansiState = null;
      io.emit('noValidTarget');
      return;
    }

    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option, remaining, targetMsg: '' });
  });

  socket.on('sansiRestTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!sansiState || sansiState.playerId !== current.id || sansiState.phase !== 'selectRestTarget') return;

    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    const option = sansiState.selectedOption;

    const applySansiRestEffect = (effTarget, effSource) => {
      if (option === '上家休息1回合，-5') {
        applyRest(effTarget.id, 1, `${coloredName(effTarget.name, effTarget.color)}休息1回合`, null, null, { skipShowEndTurn: true });
        previewMoney(effSource.id, -5);
      } else if (option === '下家休息1回合，和上家一起-4') {
        applyRest(effTarget.id, 1, `${coloredName(effTarget.name, effTarget.color)}休息1回合`, null, null, { skipShowEndTurn: true });
        const activePlayers = players.filter(p => !p.bankrupt);
        const currentIndex = activePlayers.findIndex(p => p.id === effSource.id);
        const prevPlayer = activePlayers[(currentIndex - 1 + activePlayers.length) % activePlayers.length];
        previewMoney(effSource.id, -4);
        previewMoney(prevPlayer.id, -4);
      } else if (option === '上家进医院，冻结14') {
        const doFreeze = () => {
          const freezeAmount = Math.min(14, effSource.money);
          if (freezeAmount > 0) { previewMoney(effSource.id, -freezeAmount); effSource.frozen = (effSource.frozen || 0) + freezeAmount; }
        };
        const applyHospital = (p) => { if (returnDiamondIfHeld(p)) io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 }); setPlayerState(p, 'inJail', true); if (p.inJail) { p.jailState = 'hospital'; p.position = JAIL_HOSPITAL_ID; } };
        if (!checkMianxiu(effTarget.id, '三思进医院', { skipShowEndTurn: true, onNotUsed: () => applyHospital(effTarget) })) {
          applyHospital(effTarget);
        }
        doFreeze();
      } else if (option === '和下家一起进监狱') {
        const applyJail = (p) => { if (returnDiamondIfHeld(p)) io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 }); setPlayerState(p, 'inJail', true); if (p.inJail) { p.jailState = 'jail'; p.position = 1; } };
        if (!checkMianxiu(effSource.id, '三思进监狱', { skipShowEndTurn: true, onNotUsed: () => applyJail(effSource) })) {
          applyJail(effSource);
        }
        if (!checkMianxiu(effTarget.id, '三思进监狱', { skipShowEndTurn: true, onNotUsed: () => applyJail(effTarget) })) {
          applyJail(effTarget);
        }
      }
    };

    const completeSansiRest = (finalTarget, hiddenMsg) => {
      if (finalTarget.id === current.id) {
        applySansiRestEffect(current, current);
      } else {
        applySansiRestEffect(finalTarget, current);
      }
      sansiState.phase = 'selectTarget';
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option, remaining: sansiState.remainingOptions, targetMsg: hiddenMsg ? hiddenMsg.replace(/，$/, '') : '' });
    };

    const hiddenCard = target.cards?.find(c => c.hiddenType && ['quxiao', 'jianyuan', 'zhuanyi', 'fantan'].includes(c.hiddenType));
    if (hiddenCard) {
      checkHiddenCardTarget(target.id, current.id, (cancelled) => {
        if (cancelled) {
          sansiState.phase = 'selectTarget';
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('sansiSelected', { playerId: current.id, playerName: current.name, playerColor: current.color, option, remaining: sansiState.remainingOptions });
          pendingHiddenResult = null;
          return;
        }
        let finalTarget = target;
        let hiddenMsg = '';
        if (pendingHiddenResult && pendingHiddenResult.message) {
          hiddenMsg = pendingHiddenResult.message + '，';
        }
        if (pendingHiddenResult && pendingHiddenResult.newTargetId) {
          const newTarget = players.find(p => p.id === pendingHiddenResult.newTargetId);
          if (newTarget && !newTarget.bankrupt && newTarget.id !== current.id && !newTarget.sheltered) finalTarget = newTarget;
        }
        if (pendingHiddenResult && pendingHiddenResult.type === 'fantan') {
          finalTarget = current;
        }
        pendingHiddenResult = null;
        completeSansiRest(finalTarget, hiddenMsg);
      });
      return;
    }

    completeSansiRest(target, false);
  });

  socket.on('sansiPropertyClosed', ({ propertyId }) => {
    const sender = players.find(p => p.id === socket.id);
    if (!sender) return;
    if (!sansiState || sansiState.phase !== 'selectPropertyClosed') return;

    const prop = board.find(s => s.id === propertyId);
    if (!prop || !prop.isProperty || prop.owner === null) return;

    const option = sansiState.selectedOption;
    const owner = players.find(p => p.id === prop.owner);
    if (!owner) return;

    prop.closed = true;

    if (option === '令1块地停业，给该玩家4') {
      previewMoney(owner.id, 4);
      previewMoney(sender.id, -4);
    } else if (option === '令1块地停业，冻结13') {
      const freezeAmount = Math.min(13, sender.money);
      if (freezeAmount > 0) {
        previewMoney(sender.id, -freezeAmount);
        sender.frozen = (sender.frozen || 0) + freezeAmount;
      }
    }

    const targetMsg = `令${coloredName(owner.name, owner.color)}的${prop.name}停业`;

    if (sansiState.playerId === sender.id) {
      sansiState.phase = 'selectTarget';
      sansiState.targetMsg = targetMsg;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelected', { playerId: sender.id, playerName: sender.name, playerColor: sender.color, option, remaining: sansiState.remainingOptions, targetMsg });
    } else {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiComplete', { playerId: sender.id, playerName: sender.name, playerColor: sender.color, option, targetMsg: '' });
      sansiState = null;
    }
  });

  socket.on('sansiOtherRestTarget', ({ targetId }) => {
    const sender = players.find(p => p.id === socket.id);
    if (!sender) return;
    if (!sansiState || sansiState.phase !== 'otherSelectRestTarget' || sender.id !== sansiState.targetId) return;

    const restTarget = players.find(p => p.id === targetId);
    if (!restTarget || restTarget.bankrupt || restTarget.id === sender.id) return;

    const option = sansiState.selectedOption;
    const sourcePlayer = players.find(p => p.id === sansiState.playerId);

    const applyOtherRestEffect = (effTarget, effSource) => {
      if (option === '上家休息1回合，-5') {
        applyRest(effTarget.id, 1, `${coloredName(effTarget.name, effTarget.color)}休息1回合`, null, null, { skipShowEndTurn: true });
        previewMoney(effSource.id, -5);
      } else if (option === '下家休息1回合，和上家一起-4') {
        applyRest(effTarget.id, 1, `${coloredName(effTarget.name, effTarget.color)}休息1回合`, null, null, { skipShowEndTurn: true });
        const activePlayers = players.filter(p => !p.bankrupt);
        const currentIndex = activePlayers.findIndex(p => p.id === effSource.id);
        const prevPlayer = activePlayers[(currentIndex - 1 + activePlayers.length) % activePlayers.length];
        previewMoney(effSource.id, -4);
        previewMoney(prevPlayer.id, -4);
      } else if (option === '上家进医院，冻结14') {
        const doFreeze = () => {
          const freezeAmount = Math.min(14, effSource.money);
          if (freezeAmount > 0) { previewMoney(effSource.id, -freezeAmount); effSource.frozen = (effSource.frozen || 0) + freezeAmount; }
        };
        const applyHospital = (p) => { if (returnDiamondIfHeld(p)) io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 }); setPlayerState(p, 'inJail', true); if (p.inJail) { p.jailState = 'hospital'; p.position = JAIL_HOSPITAL_ID; } };
        if (!checkMianxiu(effTarget.id, '三思进医院', { skipShowEndTurn: true, onNotUsed: () => applyHospital(effTarget) })) {
          applyHospital(effTarget);
        }
        doFreeze();
      } else if (option === '和下家一起进监狱') {
        const applyJail = (p) => { if (returnDiamondIfHeld(p)) io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 }); setPlayerState(p, 'inJail', true); if (p.inJail) { p.jailState = 'jail'; p.position = 1; } };
        if (!checkMianxiu(effSource.id, '三思进监狱', { skipShowEndTurn: true, onNotUsed: () => applyJail(effSource) })) {
          applyJail(effSource);
        }
        if (!checkMianxiu(effTarget.id, '三思进监狱', { skipShowEndTurn: true, onNotUsed: () => applyJail(effTarget) })) {
          applyJail(effTarget);
        }
      }
    };

    const completeOtherRest = (finalTarget, hiddenMsg) => {
      if (finalTarget.id === sender.id) {
        applyOtherRestEffect(sender, sender);
      } else {
        applyOtherRestEffect(finalTarget, sender);
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiComplete', { playerId: sender.id, playerName: sender.name, playerColor: sender.color, option, targetMsg: hiddenMsg ? hiddenMsg.replace(/，$/, '') : '' });
      sansiState = null;
    };

    const hiddenCard = restTarget.cards?.find(c => c.hiddenType && ['quxiao', 'jianyuan', 'zhuanyi', 'fantan'].includes(c.hiddenType));
    if (hiddenCard) {
      checkHiddenCardTarget(restTarget.id, sender.id, (cancelled) => {
        if (cancelled) {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('sansiComplete', { playerId: sender.id, playerName: sender.name, playerColor: sender.color, option });
          sansiState = null;
          pendingHiddenResult = null;
          return;
        }
        let finalTarget = restTarget;
        let hiddenMsg = '';
        if (pendingHiddenResult && pendingHiddenResult.message) {
          hiddenMsg = pendingHiddenResult.message + '，';
        }
        if (pendingHiddenResult && pendingHiddenResult.newTargetId) {
          const newTarget = players.find(p => p.id === pendingHiddenResult.newTargetId);
          if (newTarget && !newTarget.bankrupt && newTarget.id !== sender.id) finalTarget = newTarget;
        }
        if (pendingHiddenResult && pendingHiddenResult.type === 'fantan') {
          finalTarget = sender;
        }
        pendingHiddenResult = null;
        completeOtherRest(finalTarget, hiddenMsg);
      });
      return;
    }

    completeOtherRest(restTarget, '');
  });

  socket.on('sansiFlyTarget', ({ targetPos }) => {
    const sender = players.find(p => p.id === socket.id);
    if (!sender) return;
    if (!sansiState) return;

    if (sansiState.phase === 'selectFlyTarget' && sansiState.playerId === sender.id) {
      const fromPos = sansiState.flyFromPos;
      const offset = ((targetPos - fromPos) + BOARD_SIZE) % BOARD_SIZE;
      const offsetNeg = ((fromPos - targetPos) + BOARD_SIZE) % BOARD_SIZE;
      const steps = offset <= 5 ? offset : offsetNeg;
      const dir = offset <= 5 ? undefined : 'backward';
      sender.position = targetPos;
      const ap = players.filter(p => !p.bankrupt);
      const ci = ap.findIndex(p => p.id === sender.id);
      const prevP = ap[(ci - 1 + ap.length) % ap.length];
      previewMoney(sender.id, -5);
      previewMoney(prevP.id, 5);
      if (steps > 0) {
        io.emit('diceResult', { playerId: sender.id, fromPos, dice: steps, newPos: targetPos, direction: dir, teleport: true });
        diceAnimState = { playerId: sender.id, fromPos, dice: steps, newPos: targetPos };
        sansiState.pendingAnim = true;
      } else {
        sansiState.phase = 'selectTarget';
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('sansiSelected', { playerId: sender.id, playerName: sender.name, playerColor: sender.color, option: sansiState.selectedOption, remaining: sansiState.remainingOptions });
      }
    } else if (sansiState.phase === 'otherSelectFlyTarget' && sansiState.targetId === sender.id) {
      const fromPos = sansiState.flyFromPos;
      const offset = ((targetPos - fromPos) + BOARD_SIZE) % BOARD_SIZE;
      const offsetNeg = ((fromPos - targetPos) + BOARD_SIZE) % BOARD_SIZE;
      const steps = offset <= 5 ? offset : offsetNeg;
      const dir = offset <= 5 ? undefined : 'backward';
      sender.position = targetPos;
      const ap = players.filter(p => !p.bankrupt);
      const ci = ap.findIndex(p => p.id === sender.id);
      const prevP = ap[(ci - 1 + ap.length) % ap.length];
      previewMoney(sender.id, -5);
      previewMoney(prevP.id, 5);
      if (steps > 0) {
        io.emit('diceResult', { playerId: sender.id, fromPos, dice: steps, newPos: targetPos, direction: dir, teleport: true });
        diceAnimState = { playerId: sender.id, fromPos, dice: steps, newPos: targetPos };
        sansiState.pendingAnim = true;
      } else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('sansiComplete', { playerId: sender.id, playerName: sender.name, playerColor: sender.color, option: sansiState.selectedOption });
        sansiState = null;
      }
    }
  });

  socket.on('sansiTargetSelect', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!sansiState || sansiState.playerId !== current.id || sansiState.phase !== 'selectTarget') return;

    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    const completeSansiTarget = (finalTarget, hiddenMsg) => {
      sansiState.targetId = finalTarget.id;
      sansiState.phase = 'otherSelect';
      io.emit('sansiTargetChosen', { playerId: current.id, targetId: finalTarget.id, targetName: finalTarget.name, targetColor: finalTarget.color, remaining: sansiState.remainingOptions, hiddenMsg: hiddenMsg || '' });
    };

    const hiddenCard = target.cards?.find(c => c.hiddenType && ['quxiao', 'jianyuan', 'zhuanyi', 'fantan'].includes(c.hiddenType));
    if (hiddenCard) {
      checkHiddenCardTarget(target.id, current.id, (cancelled) => {
        if (cancelled) {
          sansiState = null;
          socket.emit('showEndTurn');
          pendingHiddenResult = null;
          return;
        }
        let finalTarget = target;
        let hiddenMsg = '';
        if (pendingHiddenResult && pendingHiddenResult.message) {
          hiddenMsg = pendingHiddenResult.message + '，';
        }
        if (pendingHiddenResult && pendingHiddenResult.newTargetId) {
          const newTarget = players.find(p => p.id === pendingHiddenResult.newTargetId);
          if (newTarget && !newTarget.bankrupt && newTarget.id !== current.id && !newTarget.sheltered) finalTarget = newTarget;
        }
        if (pendingHiddenResult && pendingHiddenResult.type === 'fantan') {
          finalTarget = current;
        }
        pendingHiddenResult = null;
        completeSansiTarget(finalTarget, hiddenMsg);
      });
      return;
    }

    completeSansiTarget(target, '');
  });

  socket.on('qiyuPropertySelect', ({ propertyId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id) return;

    const prop = board.find(s => s.id === propertyId);
    if (!prop || !prop.isProperty || prop.owner === null) return;

    const qiyu = qiyuState.qiyu;
    const owner = players.find(p => p.id === prop.owner);

    // 检查地产拥有者是否有保护卡
    if (owner && owner.id !== current.id && owner.cards && owner.cards.some(c => c.name === '保护卡')) {
      baohuQueryState = {
        propertyId,
        ownerId: owner.id,
        currentPlayerId: current.id,
        source: 'qiyu',
        qiyuName: qiyu.name
      };
      const ownerSocket = io.sockets.sockets.get(owner.id);
      if (ownerSocket) {
        ownerSocket.emit('baohuQuery', { propertyName: prop.name, currentPlayerName: current.name, currentPlayerColor: current.color });
      }
      // 广播给所有玩家，显示bottomBar图片覆盖
      io.emit('baohuOverlay', { targetPlayerId: owner.id, targetName: owner.name, targetColor: owner.color });
      io.emit('updateAreaE', { message: `等待${coloredName(owner.name, owner.color)}决定是否使用保护卡` });
      return;
    }

    // 执行原来的逻辑
    let message = '';

    if (qiyu.name === '查封') {
      prop.closed = true;
      message = `${prop.name}停业`;
    } else if (qiyu.name === '造谣') {
      prop.rentBonus = (prop.rentBonus || 0) - 1;
      message = `${prop.name}路费-1`;
    } else if (qiyu.name === '繁荣') {
      prop.rentBonus = (prop.rentBonus || 0) + 1;
      message = `${prop.name}路费+1`;
    }

    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('qiyuComplete', { playerId: current.id, message });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuXixinYanjiuConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id || qiyuState.qiyu.name !== '喜新厌旧') return;

    let randomCw = null;
    if (petPool.length > 0) {
      const randomIndex = Math.floor(Math.random() * petPool.length);
      randomCw = petPool.splice(randomIndex, 1)[0];
    }
    
    if (randomCw) {
      if (current.petImage) {
        if (!petPool.includes(current.petImage)) {
          petPool.push(current.petImage);
        }
      }
      current.petImage = randomCw;
    }

    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('qiyuComplete', { playerId: current.id, message: `${coloredName(current.name, current.color)}更新了宠物` });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuAnmianyaoTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id || qiyuState.qiyu.name !== '安眠药') return;

    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.sheltered || target.id === current.id) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      applyRest(finalTarget.id, 1, `${hiddenMsg}${coloredName(current.name, current.color)}令${coloredName(finalTarget.name, finalTarget.color)}休息1回合`, socket);
      qiyuState = null;
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      applyRest(source.id, 1, `反弹！${coloredName(source.name, source.color)}自己休息1回合`, socket);
      qiyuState = null;
    });
  });

  socket.on('qiyuBaguanTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id || qiyuState.qiyu.name !== '拔罐') return;

    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      const removableStatuses = [];
      if (finalTarget.extraTurns > 0) removableStatuses.push('extraTurns');
      if (finalTarget.fuwufeiExtraMove) removableStatuses.push('fuwufeiExtraMove');
      if (finalTarget.restTurns > 0) removableStatuses.push('restTurns');
      if (finalTarget.sheltered) removableStatuses.push('sheltered');
      if (finalTarget.shihua) removableStatuses.push('shihua');
      if (finalTarget.guhuoDice) removableStatuses.push('guhuoDice');
      if (finalTarget.shoumaiDice) removableStatuses.push('shoumaiDice');
      if (finalTarget.yinyueDice) removableStatuses.push('yinyueDice');
      if (finalTarget.shijieWar) removableStatuses.push('shijieWar');
      if (finalTarget.hezongState === 'forced' || finalTarget.hezongState === 'normal') removableStatuses.push('hezongState');
      if (finalTarget.diceEffects && finalTarget.diceEffects.length > 0) removableStatuses.push('diceEffects');
      if (finalTarget.daotui) removableStatuses.push('daotui');
      if (finalTarget.bingdong > 0) removableStatuses.push('bingdong');
      if (finalTarget.bomingFrozen) removableStatuses.push('bomingFrozen');
      if (finalTarget.jinzu) removableStatuses.push('jinzu');
      if (finalTarget.tuolei && finalTarget.tuolei.turns > 0) removableStatuses.push('tuolei');
      if (finalTarget.wenjigifwu) removableStatuses.push('wenjigifwu');
      if (finalTarget.dizhuTurns > 0) removableStatuses.push('dizhuTurns');
      if (finalTarget.fengkongDice && finalTarget.fengkongDice.length > 0) removableStatuses.push('fengkongDice');
      if (finalTarget.syncedDice) removableStatuses.push('syncedDice');
      if (finalTarget.cunqianList && finalTarget.cunqianList.length > 0) removableStatuses.push('cunqianList');
      if (finalTarget.tempMoney && finalTarget.tempMoney > 0 && finalTarget.tempTurns > 0) removableStatuses.push('tempMoney');
      if (finalTarget.protectedAsset) removableStatuses.push('protectedAsset');
      if (finalTarget.inJail) removableStatuses.push('inJail');

      const removedNames = {
        extraTurns: '再动次数', fuwufeiExtraMove: '服务费再动', restTurns: '休息',
        sheltered: '避难', shihua: '石化', guhuoDice: '蛊惑骰子',
        shoumaiDice: '受卖骰子', yinyueDice: '音乐指挥骰子', shijieWar: '世界大战',
        hezongState: '合纵', diceEffects: '骰子效果', daotui: '倒退',
        bingdong: '冰冻', bomingFrozen: '搏命冻结', jinzu: '禁足',
        tuolei: '拖累', wenjigifwu: '闻鸡起舞', dizhuTurns: '地主',
        fengkongDice: '封控骰子', syncedDice: '同步骰子', cunqianList: '存钱',
        tempMoney: '临时金钱', protectedAsset: '保护资产', inJail: '囚牢'
      };

      let removedName = '无状态';
      if (removableStatuses.length > 0) {
        const removed = removableStatuses[Math.floor(Math.random() * removableStatuses.length)];
        removedName = removedNames[removed] || removed;
        switch (removed) {
          case 'extraTurns': finalTarget.extraTurns = 0; break;
          case 'fuwufeiExtraMove': finalTarget.fuwufeiExtraMove = false; break;
          case 'restTurns': finalTarget.restTurns = 0; break;
          case 'sheltered': finalTarget.sheltered = false; finalTarget.shelteredTurns = 0; break;
          case 'shihua': finalTarget.shihua = false; break;
          case 'guhuoDice': finalTarget.guhuoDice = null; finalTarget.guhuoBy = null; break;
          case 'shoumaiDice': finalTarget.shoumaiDice = null; break;
          case 'yinyueDice': finalTarget.yinyueDice = null; finalTarget.yinyueBy = null; break;
          case 'shijieWar': finalTarget.shijieWar = false; break;
          case 'hezongState': finalTarget.hezongState = null; finalTarget.hezongTurns = 0; finalTarget.hezongTarget = null; break;
          case 'diceEffects': finalTarget.diceEffects = []; break;
          case 'daotui': finalTarget.daotui = false; break;
          case 'bingdong': finalTarget.bingdong = 0; break;
          case 'bomingFrozen': finalTarget.bomingFrozen = false; break;
          case 'jinzu': finalTarget.jinzu = false; break;
          case 'tuolei': finalTarget.tuolei = null; break;
          case 'wenjigifwu': finalTarget.wenjigifwu = false; break;
          case 'dizhuTurns': finalTarget.dizhuTurns = 0; break;
          case 'fengkongDice': finalTarget.fengkongDice = []; break;
          case 'syncedDice': finalTarget.syncedDice = null; finalTarget.syncedByName = null; break;
          case 'cunqianList': finalTarget.cunqianList = []; break;
          case 'tempMoney': finalTarget.tempMoney = 0; finalTarget.tempTurns = 0; break;
          case 'protectedAsset': finalTarget.protectedAsset = null; finalTarget.protectedAssetName = null; break;
          case 'inJail': finalTarget.inJail = false; finalTarget.jailState = null; finalTarget.position = 1; break;
        }
      }

      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}清除了${coloredName(finalTarget.name, finalTarget.color)}的${removedName}` });
      socket.emit('qiyuBaguanResult', { playerId: current.id });
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuBafangQianniuTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id || qiyuState.qiyu.name !== '扒房牵牛') return;

    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    const targetProperties = board.filter(s => s.isProperty && s.owner === targetId && s.houseLevel > 0);
    if (targetProperties.length === 0) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      const finalTargetProperties = board.filter(s => s.isProperty && s.owner === finalTarget.id && s.houseLevel > 0);
      if (finalTargetProperties.length === 0) {
        qiyuState = null;
        socket.emit('showEndTurn');
        return;
      }
      const randomProp = finalTargetProperties[Math.floor(Math.random() * finalTargetProperties.length)];
      randomProp.houseLevel = 0;
      
      previewMoney(current.id, -16);
      previewMoney(finalTarget.id, 16);

      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('qiyuComplete', { playerId: current.id, message: `${hiddenMsg}${coloredName(current.name, current.color)}给${coloredName(finalTarget.name, finalTarget.color)}16令${randomProp.name}房屋倒塌` });
      socket.emit('showEndTurn');
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      const sourceProperties = board.filter(s => s.isProperty && s.owner === source.id && s.houseLevel > 0);
      if (sourceProperties.length > 0) {
        const randomProp = sourceProperties[Math.floor(Math.random() * sourceProperties.length)];
        randomProp.houseLevel = 0;
        previewMoney(source.id, -16);
      }
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `反弹！${coloredName(source.name, source.color)}自己房屋倒塌-16` });
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuZaizangConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id || qiyuState.qiyu.name !== '栽赃') return;

    previewMoney(current.id, -7);
    
    qiyuState.zaizangConfirmed = true;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('qiyuZaizangSelectTarget', { playerId: current.id });
  });

  socket.on('qiyuZaizangTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id || qiyuState.qiyu.name !== '栽赃' || !qiyuState.zaizangConfirmed) return;

    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.sheltered || target.id === current.id) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      const zaizangMsg = `${hiddenMsg}${coloredName(current.name, current.color)}-7栽赃${coloredName(finalTarget.name, finalTarget.color)}进监狱`;
      qiyuState = null;
      sendToJail(finalTarget.id, '栽赃', () => {
        io.emit('qiyuComplete', { playerId: current.id, message: zaizangMsg });
        io.emit('showJailMap', { players, board, currentPlayerIndex, message: zaizangMsg, currentDiceValue });
        socket.emit('showEndTurn');
      });
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      qiyuState = null;
      sendToJail(source.id, '栽赃反弹', () => {
        io.emit('updateAreaE', { message: `反弹！${coloredName(source.name, source.color)}自己进监狱` });
        socket.emit('showEndTurn');
      });
    });
  });

  socket.on('nilaiWangwangStart', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id || qiyuState.qiyu.name !== '你来我往') return;
    
    const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && board.some(s => s.isProperty && s.owner === p.id));
    if (validTargets.length < 2) {
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: '没有合适的目标' });
      socket.emit('showEndTurn');
      return;
    }
    
    qiyuState.selectedTargets = [];
    qiyuState.selectCount = 0;
    io.emit('nilaiWangwangSelectingTarget', { playerId: current.id });
  });

  socket.on('fengdiSelectTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id || qiyuState.qiyu.name !== '封地') return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.sheltered || target.id === current.id) return;
    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      finalTarget.fengdiTurns = 3;
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}对${coloredName(finalTarget.name, finalTarget.color)}使用封地` });
      socket.emit('showEndTurn');
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      source.fengdiTurns = 3;
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `反弹！${coloredName(source.name, source.color)}被封地` });
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuNilaiWangwangTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id || qiyuState.qiyu.name !== '你来我往') return;

    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;
    if (!board.some(s => s.isProperty && s.owner === target.id)) return;
    if (qiyuState.selectedTargets.includes(targetId)) return;

    qiyuState.selectedTargets.push(targetId);
    qiyuState.selectCount++;

    if (qiyuState.selectCount < 2) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('qiyuNilaiWangwangSelectSecond', { playerId: current.id, firstTargetId: targetId });
      return;
    }

    withHiddenCheck(current.id, qiyuState.selectedTargets[0], (finalTarget1, hiddenMsg1) => {
      withHiddenCheck(current.id, qiyuState.selectedTargets[1], (finalTarget2, hiddenMsg2) => {
        const props1 = board.filter(s => s.isProperty && s.owner === finalTarget1.id);
        const props2 = board.filter(s => s.isProperty && s.owner === finalTarget2.id);

        if (props1.length === 0 || props2.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuComplete', { playerId: current.id, message: `互换失败，没有足够的地产` });
          socket.emit('showEndTurn');
          return;
        }

        const randomProp1 = props1[Math.floor(Math.random() * props1.length)];
        const randomProp2 = props2[Math.floor(Math.random() * props2.length)];

        randomProp1.owner = finalTarget2.id;
        randomProp2.owner = finalTarget1.id;

        const prop1Name = randomProp1.name;
        const prop2Name = randomProp2.name;

        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuComplete', { playerId: current.id, message: `${hiddenMsg1}${hiddenMsg2}${coloredName(finalTarget1.name, finalTarget1.color)}的${prop1Name}与${coloredName(finalTarget2.name, finalTarget2.color)}的${prop2Name}互换` });
        socket.emit('showEndTurn');
      }, () => {
        qiyuState = null;
        socket.emit('showEndTurn');
      });
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    });
  });

  socket.on('meirenjiStart', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id || qiyuState.qiyu.name !== '美人计') return;
    
    const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
    if (validTargets.length < 2) {
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: '没有合适的目标' });
      socket.emit('showEndTurn');
      return;
    }
    
    qiyuState.selectedTargets = [];
    qiyuState.selectCount = 0;
    io.emit('meirenjiSelectingTarget', { playerId: current.id });
  });

  socket.on('qiyuMeirenjiTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id || qiyuState.qiyu.name !== '美人计') return;

    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;
    if (qiyuState.selectedTargets.includes(targetId)) return;

    qiyuState.selectedTargets.push(targetId);
    qiyuState.selectCount++;

    if (qiyuState.selectCount < 2) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('qiyuMeirenjiSelectSecond', { playerId: current.id, firstTargetId: targetId });
      return;
    }

    withHiddenCheck(current.id, qiyuState.selectedTargets[0], (finalTarget1, hiddenMsg1) => {
      withHiddenCheck(current.id, qiyuState.selectedTargets[1], (finalTarget2, hiddenMsg2) => {
        meirenjiState = {
          commanderId: current.id,
          commanderName: current.name,
          commanderColor: current.color,
          target1Id: finalTarget1.id,
          target1Name: finalTarget1.name,
          target1Color: finalTarget1.color,
          target2Id: finalTarget2.id,
          target2Name: finalTarget2.name,
          target2Color: finalTarget2.color,
          bid1: null,
          bid2: null
        };

        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('meirenjiPanel', {
          commanderId: current.id,
          commanderName: current.name,
          target1Id: finalTarget1.id, target1Name: finalTarget1.name, target1Color: finalTarget1.color,
          target2Id: finalTarget2.id, target2Name: finalTarget2.name, target2Color: finalTarget2.color
        });
      }, () => {
        qiyuState = null;
        socket.emit('showEndTurn');
      });
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    });
  });

  socket.on('meirenjiBid', ({ targetId, amount }) => {
    if (!meirenjiState) return;
    const current = players[currentPlayerIndex];
    if (!current) return;

    if (targetId === meirenjiState.target1Id) {
      meirenjiState.bid1 = amount;
    } else if (targetId === meirenjiState.target2Id) {
      meirenjiState.bid2 = amount;
    }

    if (meirenjiState.bid1 !== null && meirenjiState.bid2 !== null) {
      const commander = players.find(p => p.id === meirenjiState.commanderId);
      let t1 = players.find(p => p.id === meirenjiState.target1Id);
      let t2 = players.find(p => p.id === meirenjiState.target2Id);

      if (meirenjiState.bid1 === meirenjiState.bid2) {
        const bid = meirenjiState.bid1;
        previewMoney(t1.id, -bid);
        previewMoney(t2.id, -bid);
        previewMoney(commander.id, bid * 2);
        meirenjiState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(t1.name, t1.color)}和${coloredName(t2.name, t2.color)}各出价${bid}给${coloredName(commander.name, commander.color)}，平局` });
        io.emit('meirenjiEnd', { commanderId: commander.id });
        return;
      }

      let winner, loser, winBid, loseBid;
      if (meirenjiState.bid1 > meirenjiState.bid2) {
        winner = t1; loser = t2; winBid = meirenjiState.bid1; loseBid = meirenjiState.bid2;
      } else {
        winner = t2; loser = t1; winBid = meirenjiState.bid2; loseBid = meirenjiState.bid1;
      }

      previewMoney(winner.id, -winBid);
      previewMoney(commander.id, winBid);

      const loserProps = board.filter(s => s.isProperty && s.owner === loser.id && s.houseLevel > 0);
      let loserResult = '';
      if (loserProps.length > 0) {
        const randomProp = loserProps[Math.floor(Math.random() * loserProps.length)];
        randomProp.houseLevel -= 1;
        loserResult = `，${randomProp.name}降级`;
      } else {
        previewMoney(loser.id, -10);
        loserResult = '-10';
      }

      meirenjiState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(winner.name, winner.color)}出价${winBid}给${coloredName(commander.name, commander.color)}，${coloredName(loser.name, loser.color)}出价${loseBid}输${loserResult}` });
      io.emit('meirenjiEnd', { commanderId: commander.id });
    }
  });

  socket.on('qiyuGuhuoTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id || qiyuState.qiyu.name !== '蛊惑') return;

    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('qiyuGuhuoDice', { playerId: current.id, targetId: finalTarget.id, targetName: finalTarget.name, targetColor: finalTarget.color });
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('qiyuGuhuoDice', { playerId: current.id, targetId: source.id, targetName: source.name, targetColor: source.color });
    });
  });

  socket.on('qiyuGuhuoDiceSelect', ({ targetId, diceValue }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;

    target.guhuoDice = diceValue;
    target.guhuoBy = current.name;
    target.guhuoByColor = current.color;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `蛊惑：${coloredName(current.name, current.color)}指定${coloredName(target.name, target.color)}下回合点数${diceValue}` });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuGanjinJuejueTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      previewMoney(finalTarget.id, -14);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}令${coloredName(finalTarget.name, finalTarget.color)}-14` });
      socket.emit('showEndTurn');
    }, () => {
      socket.emit('showEndTurn');
    }, (source) => {
      previewMoney(source.id, -14);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `反弹！${coloredName(source.name, source.color)}自己-14` });
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuLianyinProp', ({ propId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const prop = board.find(s => s.id === propId);
    if (!prop || prop.owner !== current.id) return;

    qiyuState = { playerId: current.id, qiyu: { name: '联姻' }, propId: propId };
    io.emit('qiyuLianyinSelectTarget', { playerId: current.id, propId: propId, propName: prop.name });
  });

  socket.on('qiyuLianyinTarget', ({ targetId, propId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;
    const prop = board.find(s => s.id === propId);
    if (!prop || prop.owner !== current.id) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      prop.owner = finalTarget.id;
      previewMoney(finalTarget.id, -40);
      previewMoney(current.id, 40);
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}将${prop.name}给${coloredName(finalTarget.name, finalTarget.color)}，${coloredName(finalTarget.name, finalTarget.color)}还给${coloredName(current.name, current.color)}40` });
      socket.emit('showEndTurn');
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      prop.owner = source.id;
      previewMoney(source.id, -40);
      previewMoney(current.id, 40);
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `反弹！${coloredName(source.name, source.color)}获得${prop.name}，给${coloredName(current.name, current.color)}40` });
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuYinhuoDefuProp', ({ propId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const prop = board.find(s => s.id === propId);
    if (!prop || prop.owner !== current.id) return;

    // 检查保护地产
    if (!checkProtectedAsset(current.id, 'property')) {
      const bonus = prop.price + prop.houseLevel * Math.floor(prop.price / 3) + 10;
      prop.owner = null;
      prop.houseLevel = 0;
      previewMoney(current.id, bonus);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}失去${prop.name}获得${bonus}` });
    }
    socket.emit('showEndTurn');
  });

  socket.on('qiyuTangying', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const dice = Math.floor(Math.random() * 6) + 1;
    const bonus = dice * 2;
    previewMoney(current.id, bonus);
    qiyuState = null;
    applyRest(current.id, 1, `${coloredName(current.name, current.color)}休息1回合并+${bonus}`, socket);
  });

  socket.on('qiyuChuanxiao', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const activePlayers = players.filter(p => !p.bankrupt);
    chuanxiaoState = { 
      phase: 'bidding', 
      bids: {}, 
      playerId: current.id,
      playerIds: activePlayers.map(p => p.id),
      numbers: {},
      confirmedCount: 0
    };
    
    activePlayers.forEach(p => {
      const playerSocket = io.sockets.sockets.get(p.id);
      if (playerSocket) {
        playerSocket.emit('qiyuChuanxiaoStart', { 
          playerId: p.id, 
          playerName: p.name, 
          playerColor: p.color 
        });
      }
    });
  });

  socket.on('chuanxiaoPinqianAdd', (value) => {
    if (!chuanxiaoState) return;
    const playerId = socket.id;
    if (!chuanxiaoState.playerIds.includes(playerId)) return;
    
    chuanxiaoState.numbers[playerId] = (chuanxiaoState.numbers[playerId] || 0) + value;
    const player = players.find(p => p.id === playerId);
    if (player && player.money < chuanxiaoState.numbers[playerId]) {
      chuanxiaoState.numbers[playerId] = player.money;
    }
    socket.emit('chuanxiaoPinqianUpdate', { number: chuanxiaoState.numbers[playerId] });
  });

  socket.on('chuanxiaoPinqianClear', () => {
    if (!chuanxiaoState) return;
    const playerId = socket.id;
    if (!chuanxiaoState.playerIds.includes(playerId)) return;
    
    chuanxiaoState.numbers[playerId] = 0;
    socket.emit('chuanxiaoPinqianUpdate', { number: 0 });
  });

  socket.on('chuanxiaoPinqianConfirmWithValue', (value) => {
    if (!chuanxiaoState) return;
    const playerId = socket.id;
    if (!chuanxiaoState.playerIds.includes(playerId)) return;
    if (chuanxiaoState.bids[playerId] !== undefined) return;
    
    const number = parseInt(value) || 0;
    if (number <= 0) return;
    
    const player = players.find(p => p.id === playerId);
    if (!player || player.money < number) return;
    
    // 确认时不显示扣钱动画，只记录出价
    chuanxiaoState.bids[playerId] = number;
    chuanxiaoState.numbers[playerId] = number;
    chuanxiaoState.confirmedCount++;
    socket.emit('chuanxiaoPinqianConfirmed');
    
    if (chuanxiaoState.confirmedCount >= chuanxiaoState.playerIds.length) {
      const bids = chuanxiaoState.bids;
      let maxBid = Math.max(...Object.values(bids));
      let maxPlayers = Object.keys(bids).filter(id => bids[id] === maxBid);
      
      const activePlayers = players.filter(p => !p.bankrupt);
      const bidDetails = activePlayers.map(p => {
        const bid = bids[p.id] || 0;
        return `${coloredName(p.name, p.color)}-${bid}`;
      }).join('，');
      
      if (maxPlayers.length === 1) {
        const winner = players.find(p => p.id === maxPlayers[0]);
        // 结算时才显示扣钱动画
        activePlayers.forEach(p => {
          const bid = bids[p.id] || 0;
          if (p.id === winner.id) {
            // 赢家：先扣出价，再获得每人5
            if (bid > 0) previewMoney(p.id, -bid);
            const totalGain = (activePlayers.length - 1) * 5;
            previewMoney(p.id, totalGain);
          } else {
            // 其他玩家：先扣出价，再额外-5给赢家
            if (bid > 0) previewMoney(p.id, -bid);
            previewMoney(p.id, -5);
          }
        });
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        io.emit('updateAreaE', { message: `${coloredName(winner.name, winner.color)}-${bids[winner.id]}获得每人5，${activePlayers.filter(p => p.id !== winner.id).map(p => `${coloredName(p.name, p.color)}-${bids[p.id] || 0}-5`).join('，')}` });
      } else {
        // 平局：所有人只扣出价
        activePlayers.forEach(p => {
          const bid = bids[p.id] || 0;
          if (bid > 0) {
            previewMoney(p.id, -bid);
          }
        });
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        io.emit('updateAreaE', { message: bidDetails });
      }
      
      io.emit('qiyuChuanxiaoEnd');
      chuanxiaoState = null;
      qiyuState = null;
    }
  });

  socket.on('qiyuBomingTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      previewMoney(current.id, -9);
      previewMoney(finalTarget.id, 9);
      finalTarget.bomingFrozen = current.id;
      finalTarget.bomingFrozenUntil = current.id;
      
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}给${coloredName(finalTarget.name, finalTarget.color)}9，令其冻结所有钱1回合` });
      socket.emit('showEndTurn');
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      previewMoney(current.id, -9);
      previewMoney(source.id, 9);
      source.bomingFrozen = current.id;
      source.bomingFrozenUntil = current.id;
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `反弹！${coloredName(source.name, source.color)}自己冻结所有钱1回合` });
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuJiefuJipinConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const others = players.filter(p => !p.bankrupt && p.id !== current.id);
    if (others.length < 2) return;
    const maxMoney = Math.max(...others.map(p => p.money));
    const minMoney = Math.min(...others.map(p => p.money));
    const richest = others.filter(p => p.money === maxMoney);
    const poorest = others.filter(p => p.money === minMoney);
    const richestPlayer = richest[Math.floor(Math.random() * richest.length)];
    const poorestPlayer = poorest[Math.floor(Math.random() * poorest.length)];
    previewMoney(richestPlayer.id, -8);
    previewMoney(poorestPlayer.id, 8);
    previewMoney(current.id, 5);
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}劫富济贫+5，${coloredName(richestPlayer.name, richestPlayer.color)}给${coloredName(poorestPlayer.name, poorestPlayer.color)}8` });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuLunliuzhuan', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const activePlayers = players.filter(p => !p.bankrupt);
    if (activePlayers.length < 2) {
      qiyuState = null;
      socket.emit('showEndTurn');
      return;
    }
    
    const positions = activePlayers.map(p => p.position);
    for (let i = 0; i < activePlayers.length; i++) {
      const nextIndex = (i + 1) % activePlayers.length;
      activePlayers[i].position = positions[nextIndex];
    }
    
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('qiyuLunliuzhuanDone');
  });

  socket.on('qiyuXianjinLiushui', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    if (current.money >= 40) {
      socket.emit('qiyuXianjinLiushuiFail');
      return;
    }
    
    previewMoney(current.id, 40 - current.money);
    current.money = 40;
    
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}将现金补充到40` });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuZoushoufanzi', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    let randomCw = null;
    if (petPool.length > 0) {
      const randomIndex = Math.floor(Math.random() * petPool.length);
      randomCw = petPool[randomIndex];
    }
    
    if (!randomCw) {
      io.emit('updateAreaE', { message: '宠物库已空' });
      socket.emit('showEndTurn');
      qiyuState = null;
      return;
    }
    
    const activePlayers = players.filter(p => !p.bankrupt);
    
    auctionState = {
      card: null,
      petImage: randomCw,
      bids: {},
      passedPlayers: [],
      currentBidderIndex: activePlayers.findIndex(p => p.id === current.id),
      activePlayers: activePlayers.map(p => p.id),
      currentBid: 0,
      lastBidderId: null,
      isPetAuction: true,
      qiyuSource: '走私贩子'
    };
    
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    const petInfo = getPetInfo(randomCw);
    io.emit('petAuctionStart', {
      petImage: randomCw,
      petName: petInfo ? petInfo.name : '',
      petDesc: petInfo ? petInfo.desc : '',
      currentBidderId: current.id,
      currentBidderName: current.name,
      currentBidderColor: current.color,
      qiyuSource: '走私贩子'
    });
  });

  let qiyuJinzuSelecting = false;

  socket.on('qiyuJinzuTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      finalTarget.jinzu = current.id;
      
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}令${coloredName(finalTarget.name, finalTarget.color)}禁足，下回合停留原地` });
      socket.emit('showEndTurn');
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      source.jinzu = current.id;
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `反弹！${coloredName(source.name, source.color)}自己禁足` });
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuHunanganshiTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState || qiyuState.playerId !== current.id || qiyuState.qiyu.name !== '湖南赶尸') return;

    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.sheltered) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      const BOARD_SIZE = board.length;
      const fromPos = finalTarget.position;
      let newPos = fromPos - 3;
      if (newPos < 0) newPos += BOARD_SIZE;
      finalTarget.position = newPos;

      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}令${coloredName(finalTarget.name, finalTarget.color)}后退3步` });
      socket.emit('showEndTurn');
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      const BOARD_SIZE = board.length;
      const fromPos = source.position;
      let newPos = fromPos - 3;
      if (newPos < 0) newPos += BOARD_SIZE;
      source.position = newPos;
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `反弹！${coloredName(source.name, source.color)}自己后退3步` });
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuLeshanHaoshiConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    previewMoney(current.id, 10);
    
    const activePlayers = players.filter(p => !p.bankrupt);
    const maxMoney = Math.max(...activePlayers.map(p => p.money));
    const minMoney = Math.min(...activePlayers.map(p => p.money));
    
    const isMax = current.money >= maxMoney;
    
    if (isMax && activePlayers.length > 1) {
      const minPlayers = activePlayers.filter(p => p.money === minMoney);
      const target = minPlayers[Math.floor(Math.random() * minPlayers.length)];
      previewMoney(target.id, 9);
      current.money -= 9;
      
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}+10，给${coloredName(target.name, target.color)}9` });
      socket.emit('showEndTurn');
    } else {
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}+10` });
      socket.emit('showEndTurn');
    }
  });

  socket.on('qiyuLiufangTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      previewMoney(current.id, -11);
      const applyIsland = (p, msg) => {
        setPlayerState(p, 'inJail', true);
        if (!p.inJail) return;
        p.position = JAIL_ISLAND_ID;
        p.jailState = 'island';
        p.jailTurns = 0;
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${msg}${coloredName(current.name, current.color)}-11令${coloredName(p.name, p.color)}到海南` });
        socket.emit('showEndTurn');
      };
      // 检查免休卡
      if (!checkMianxiu(finalTarget.id, '进海南', { skipShowEndTurn: true, onNotUsed: () => applyIsland(finalTarget, hiddenMsg) })) {
        applyIsland(finalTarget, hiddenMsg);
      }
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      previewMoney(current.id, -11);
      const applyIslandSelf = (p, msg) => {
        setPlayerState(p, 'inJail', true);
        if (!p.inJail) return;
        p.position = JAIL_ISLAND_ID;
        p.jailState = 'island';
        p.jailTurns = 0;
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${msg}${coloredName(p.name, p.color)}自己到海南` });
        socket.emit('showEndTurn');
      };
      // 检查免休卡（反弹时自己也要检查）
      if (!checkMianxiu(source.id, '进海南', { skipShowEndTurn: true, onNotUsed: () => applyIslandSelf(source, '反弹！') })) {
        applyIslandSelf(source, '反弹！');
      }
    });
  });

  socket.on('goToIsland', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;

    sendToIsland(current.id, () => {
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}到海南` });
      socket.emit('showEndTurn');
    });
  });

  socket.on('triggerGaokao', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    io.emit('updateAreaE', { message: '高考：群体竞价拼钱，按名次依次获得50-20-0-负10-负20-负50' });
    const activePlayers = players.filter(p => !p.bankrupt);
    gaokaoState = {
      players: activePlayers.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        number: 0,
        confirmed: false
      })),
      rewards: [50, 20, 0, -10, -20, -50]
    };
    activePlayers.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) {
        s.emit('gaokaoStart', {
          playerName: p.name,
          playerColor: p.color
        });
      }
    });
  });

  socket.on('qiyuJiebanWanleTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      current.position = 23;
      finalTarget.position = 23;

      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}与${coloredName(finalTarget.name, finalTarget.color)}到上海` });
      socket.emit('showEndTurn');
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      current.position = 23;
      source.position = 23;
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `反弹！${coloredName(current.name, current.color)}与${coloredName(source.name, source.color)}到上海` });
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuTuoleiTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      current.tuolei = { by: current.name, byColor: current.color, turns: 1 };
      finalTarget.tuolei = { by: current.name, byColor: current.color, turns: 1 };
      
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}拖累${coloredName(finalTarget.name, finalTarget.color)}，两人下回合掷1-2` });
      socket.emit('showEndTurn');
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      current.tuolei = { by: current.name, byColor: current.color, turns: 1 };
      source.tuolei = { by: current.name, byColor: current.color, turns: 1 };
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `反弹！${coloredName(current.name, current.color)}拖累${coloredName(source.name, source.color)}，两人下回合掷1-2` });
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuFuwufeiTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      previewMoney(finalTarget.id, -5);
      previewMoney(current.id, 5);
      
      finalTarget.fuwufeiExtraMove = true;
      
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}收取5令${coloredName(finalTarget.name, finalTarget.color)}再动一次` });
      socket.emit('showEndTurn');
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      previewMoney(source.id, -5);
      previewMoney(current.id, 5);
      source.fuwufeiExtraMove = true;
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `反弹！${coloredName(source.name, source.color)}自己-5且再动一次` });
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuTanwuConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;

    previewMoney(current.id, 20);
    // 返还钻石
    if (returnDiamondIfHeld(current)) {
      io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
    }
    setPlayerState(current, 'inJail', true);
    if (current.inJail) {
      current.jailState = 'jail';
      current.position = JAIL_JAIL_ID;
    }
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}贪污+20并进监狱` });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuYunshiFreeze', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const freezeAmount = Math.min(25, current.money);
    if (freezeAmount > 0) {
      current.money -= freezeAmount;
      current.frozen = (current.frozen || 0) + freezeAmount;
    }
    
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuYunshiMinus', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    previewMoney(current.id, -10);
    
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuZhiboShuijiaoConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    applyRest(current.id, 1, `${coloredName(current.name, current.color)}获得每人3`, socket, () => {
      let totalReceived = 0;
      players.forEach(p => {
        if (p.id !== current.id && !p.bankrupt) {
          previewMoney(p.id, -3);
          totalReceived += 3;
        }
      });
      previewMoney(current.id, totalReceived);
      qiyuState = null;
    });
  });

  socket.on('qiyuYanhuiConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const myPropertyCount = board.filter(s => s.isProperty && s.owner === current.id).length;
    if (myPropertyCount === 0) {
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}没有地产，宴会无效` });
      socket.emit('showEndTurn');
      return;
    }
    
    const activePlayers = players.filter(p => !p.bankrupt);
    const moneyMap = new Map();
    let count = myPropertyCount;
    let idx = activePlayers.findIndex(p => p.id === current.id);
    
    while (count > 0) {
      const target = activePlayers[idx];
      const currentMoney = moneyMap.get(target.id) || 0;
      moneyMap.set(target.id, currentMoney + 5);
      previewMoney(target.id, 5);
      count--;
      idx = (idx + 1) % activePlayers.length;
    }
    
    const results = [];
    for (const [playerId, totalMoney] of moneyMap) {
      const player = players.find(p => p.id === playerId);
      if (player) {
        results.push(`${coloredName(player.name, player.color)}+${totalMoney}`);
      }
    }
    
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: results.join('，') });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuAiwuJiwuSelect', ({ propertyId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const property = board.find(s => s.id === propertyId);
    if (!property || property.owner !== current.id) return;
    
    if (petPool.length === 0) {
      io.emit('updateAreaE', { message: '宠物库已空' });
      socket.emit('showEndTurn');
      qiyuState = null;
      return;
    }
    
    const randomIndex = Math.floor(Math.random() * petPool.length);
    const randomPet = petPool.splice(randomIndex, 1)[0];
    
    property.owner = null;
    property.houseLevel = 0;
    current.petImage = randomPet;
    current.originalPetImage = null;
    
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}失去${property.name}，获得宠物` });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuTudijianbingSelectTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const target = players.find(p => p.id === targetId);
    if (!target || target.id === current.id || target.bankrupt) return;
    
    const targetHasProperty = board.some(s => s.isProperty && s.owner === targetId);
    if (!targetHasProperty) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      const finalTargetHasProperty = board.some(s => s.isProperty && s.owner === finalTarget.id);
      if (!finalTargetHasProperty) {
        qiyuState = null;
        socket.emit('showEndTurn');
        return;
      }

      tudijianbingState = {
        initiatorId: current.id,
        targetId: finalTarget.id,
        initiatorPropertyId: null,
        targetPropertyId: null
      };
      
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('qiyuTudijianbingSelectProperty', {
        initiatorId: current.id,
        targetId: finalTarget.id,
        initiatorName: current.name,
        targetName: finalTarget.name
      });
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuTudijianbingSelectProperty', ({ propertyId }) => {
    const sender = players.find(p => p.id === socket.id);
    if (!sender || !tudijianbingState) return;
    
    if (sender.id === tudijianbingState.initiatorId && !tudijianbingState.initiatorPropertyId) {
      const property = board.find(s => s.id === propertyId);
      if (!property || property.owner !== sender.id) return;
      tudijianbingState.initiatorPropertyId = propertyId;
    } else if (sender.id === tudijianbingState.targetId && !tudijianbingState.targetPropertyId) {
      const property = board.find(s => s.id === propertyId);
      if (!property || property.owner !== sender.id) return;
      tudijianbingState.targetPropertyId = propertyId;
    }
    
    if (tudijianbingState.initiatorPropertyId && tudijianbingState.targetPropertyId) {
      const propA = board.find(s => s.id === tudijianbingState.initiatorPropertyId);
      const propB = board.find(s => s.id === tudijianbingState.targetPropertyId);
      const initiator = players.find(p => p.id === tudijianbingState.initiatorId);
      const target = players.find(p => p.id === tudijianbingState.targetId);
      
      const valueA = propA.price + propA.houseLevel * Math.floor(propA.price / 3);
      const valueB = propB.price + propB.houseLevel * Math.floor(propB.price / 3);
      const totalValue = valueA + valueB;
      
      let winner, loser, winnerProp, loserProp;
      if (valueA >= valueB) {
        winner = initiator;
        loser = target;
        winnerProp = propA;
        loserProp = propB;
      } else {
        winner = target;
        loser = initiator;
        winnerProp = propB;
        loserProp = propA;
      }
      
      loserProp.owner = winner.id;
      // 保持原有房产数量，不变为0房
      previewMoney(winner.id, -totalValue);
      previewMoney(loser.id, totalValue);
      
      qiyuState = null;
      tudijianbingState = null;
      
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(winner.name, winner.color)}获得${loserProp.name}，补偿给${coloredName(loser.name, loser.color)}${totalValue}` });
      io.emit('qiyuTudijianbingEnd');
    } else {
      const waitingPlayerId = sender.id === tudijianbingState.initiatorId ? tudijianbingState.targetId : tudijianbingState.initiatorId;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.to(waitingPlayerId).emit('qiyuTudijianbingSelectProperty', {
        initiatorId: tudijianbingState.initiatorId,
        targetId: tudijianbingState.targetId,
        initiatorName: players.find(p => p.id === tudijianbingState.initiatorId)?.name,
        targetName: players.find(p => p.id === tudijianbingState.targetId)?.name
      });
      io.to(sender.id).emit('qiyuTudijianbingWaiting', { 
        waitingFor: waitingPlayerId 
      });
    }
  });

  socket.on('qiyuXiaolicangdaoSelectProp', ({ propertyId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const property = board.find(s => s.id === propertyId);
    if (!property || property.owner !== current.id) return;
    
    xiaolicangdaoState = { playerId: current.id, propertyId };
    const targets = players.filter(p => p.id !== current.id && !p.bankrupt);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('qiyuXiaolicangdaoSelectTarget', {
      playerId: current.id,
      targets: targets.map(t => ({ id: t.id, name: t.name, color: t.color }))
    });
  });

  socket.on('qiyuXiaolicangdaoConfirm', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id || !xiaolicangdaoState) return;
    
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;
    
    const property = board.find(s => s.id === xiaolicangdaoState.propertyId);
    if (!property || property.owner !== current.id) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      withPropertyProtection(finalTarget.id, () => {
        const money = property.price + 15;
        property.owner = finalTarget.id;
        // 保持原有房产数量，不变为0房
        previewMoney(finalTarget.id, -money);
        previewMoney(current.id, money);
        
        xiaolicangdaoState = null;
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}把${property.name}给${coloredName(finalTarget.name, finalTarget.color)}，获得其${money}` });
        socket.emit('showEndTurn');
      });
    }, () => {
      xiaolicangdaoState = null;
      qiyuState = null;
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuXiaduConfirm', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || !target.petImage) return;
    
    if (current.money < 37) {
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}金钱不足37，下毒失败` });
      return;
    }

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      if (!finalTarget.petImage) {
        qiyuState = null;
        socket.emit('showEndTurn');
        return;
      }
      withPetProtection(finalTarget.id, () => {
        previewMoney(current.id, -37);
        if (!petPool.includes(finalTarget.petImage)) {
          petPool.push(finalTarget.petImage);
        }
        finalTarget.petImage = null;
        finalTarget.originalPetImage = null;
        
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}-37令${coloredName(finalTarget.name, finalTarget.color)}失去宠物` });
        socket.emit('showEndTurn');
      });
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      withPetProtection(source.id, () => {
        previewMoney(current.id, -37);
        if (!petPool.includes(source.petImage)) {
          petPool.push(source.petImage);
        }
        source.petImage = null;
        source.originalPetImage = null;
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `反弹！${coloredName(source.name, source.color)}自己失去宠物` });
        socket.emit('showEndTurn');
      });
    });
  });

  socket.on('qiyuJietouDouruConfirm', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;

    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      qiyuState = null;
      // 先让当前玩家进监狱
      sendToJail(current.id, '街头斗殴', () => {
        // 再让目标玩家进监狱
        sendToJail(finalTarget.id, '街头斗殴', () => {
          io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}与${coloredName(finalTarget.name, finalTarget.color)}进监狱` });
          socket.emit('showEndTurn');
        });
      });
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuBanzhuanDarenConfirm', ({ propertyId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const property = board.find(s => s.id === propertyId);
    if (!property || !property.isProperty || property.owner !== current.id) return;
    
    if (property.houseLevel >= 4) {
      io.emit('updateAreaE', { message: `${property.name}已满级，无法升级` });
      socket.emit('showEndTurn');
      return;
    }
    
    if (current.money < 15) {
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}金钱不足15，搬砖失败` });
      socket.emit('showEndTurn');
      return;
    }
    
    previewMoney(current.id, -15);
    const oldLevel = property.houseLevel;
    property.houseLevel += 1;
    
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}花15令${property.name}盖房升级` });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuTiemenConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const keyIndex = current.cards ? current.cards.findIndex(c => c.id === 13) : -1;
    if (keyIndex === -1) return;
    current.cards.splice(keyIndex, 1);
    const allCardIds = [1,2,3,4,5,6,7,8,9,10,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28];
    for (let i = 0; i < 4; i++) {
      const randomId = allCardIds[Math.floor(Math.random() * allCardIds.length)];
      const card = cardData.find(c => c.id === randomId);
      if (card) addCardToPlayer(current, card);
    }
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用钥匙，随机获得4张卡` });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuYinmenConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const keyIndex = current.cards ? current.cards.findIndex(c => c.id === 13) : -1;
    if (keyIndex === -1) return;
    current.cards.splice(keyIndex, 1);
    current.salary = (current.salary || 10) + 30;
    board.filter(s => s.isProperty && s.owner === current.id).forEach(s => {
      s.rentBonus = (s.rentBonus || 0) + 3;
    });
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用钥匙，工资+30，所有地产过路费+3` });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuFanzhuanChoice', ({ choice }) => {
    if (!fanzhuanState || fanzhuanState.phase !== 'selecting') return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt) return;
    
    if (socket.id === fanzhuanState.currentPlayerId) {
      fanzhuanState.currentChoice = choice;
    } else {
      fanzhuanState.otherChoices[socket.id] = choice;
    }
    
    io.to(socket.id).emit('qiyuFanzhuanChoiceMade');
    
    const activePlayers = players.filter(p => !p.bankrupt);
    const allChosen = fanzhuanState.currentChoice !== null && 
                      activePlayers.every(p => p.id === fanzhuanState.currentPlayerId || fanzhuanState.otherChoices[p.id] !== undefined);
    
    if (allChosen) {
      fanzhuanState.phase = 'result';
      
      const current = players.find(p => p.id === fanzhuanState.currentPlayerId);
      let currentResult = fanzhuanState.currentChoice;
      const hasFanzhuan = Object.values(fanzhuanState.otherChoices).some(c => c === '反转');
      
      const fanzhuanPlayers = [];
      const minus5Players = [];
      
      if (hasFanzhuan) {
        for (const [pid, c] of Object.entries(fanzhuanState.otherChoices)) {
          if (c === '反转') {
            fanzhuanPlayers.push(players.find(p => p.id === pid));
          } else {
            minus5Players.push(players.find(p => p.id === pid));
          }
        }
        
        const actualResult = currentResult === '+10' ? -10 : 10;
        previewMoney(current.id, actualResult);
        
        for (const fp of fanzhuanPlayers) {
          const gain = currentResult === '+10' ? 10 : -10;
          previewMoney(fp.id, gain);
        }
        
        for (const mp of minus5Players) {
          previewMoney(mp.id, -5);
        }
        
        let msg = `${coloredName(current.name, current.color)}被反转${actualResult > 0 ? '+' + actualResult : actualResult}`;
        if (fanzhuanPlayers.length > 0) {
          msg += `，${fanzhuanPlayers.map(p => coloredName(p.name, p.color)).join('、')}因为反转${currentResult}`;
        }
        if (minus5Players.length > 0) {
          msg += `，${minus5Players.map(p => coloredName(p.name, p.color)).join('、')}-5`;
        }
        
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: msg });
        io.to(fanzhuanState.currentPlayerId).emit('showEndTurn');
        fanzhuanState = null;
      } else {
        const actualResult = currentResult === '+10' ? 10 : -10;
        previewMoney(current.id, actualResult);
        
        for (const [pid, c] of Object.entries(fanzhuanState.otherChoices)) {
          const p = players.find(pl => pl.id === pid);
          if (c === '-5') {
            previewMoney(p.id, -5);
            minus5Players.push(p);
          }
        }
        
        let msg = `${coloredName(current.name, current.color)}${actualResult > 0 ? '+' + actualResult : actualResult}`;
        if (minus5Players.length > 0) {
          msg += `，${minus5Players.map(p => coloredName(p.name, p.color)).join('、')}-5`;
        }
        
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: msg });
        io.to(fanzhuanState.currentPlayerId).emit('showEndTurn');
        fanzhuanState = null;
      }
    }
  });

  socket.on('baozhengChoice', ({ choice }) => {
    if (!baozhengState || baozhengState.phase !== 'selecting') return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt) return;
    if (socket.id === baozhengState.currentPlayerId) return;
    
    baozhengState.choices[socket.id] = choice;
    io.to(socket.id).emit('baozhengChoiceMade');
    
    const activeOthers = players.filter(p => !p.bankrupt && p.id !== baozhengState.currentPlayerId);
    const allChosen = activeOthers.every(p => baozhengState.choices[p.id] !== undefined);
    
    if (allChosen) {
      baozhengState.phase = 'result';
      
      const current = players.find(p => p.id === baozhengState.currentPlayerId);
      const fankangPlayers = [];
      const jingongPlayers = [];
      
      for (const [pid, c] of Object.entries(baozhengState.choices)) {
        const p = players.find(pl => pl.id === pid);
        if (c === '反抗') {
          fankangPlayers.push(p);
        } else {
          jingongPlayers.push(p);
        }
      }
      
      if (fankangPlayers.length > 0) {
        const randomIdx = Math.floor(Math.random() * fankangPlayers.length);
        const randomFankang = fankangPlayers[randomIdx];
        previewMoney(randomFankang.id, -14);
        
        let currentNetChange = 0;
        for (const jp of jingongPlayers) {
          previewMoney(jp.id, -2);
          currentNetChange += 2;
        }
        for (const fp of fankangPlayers) {
          if (fp.id !== randomFankang.id) {
            previewMoney(current.id, -2);
            previewMoney(fp.id, 2);
          }
        }
        
        let msg = `${coloredName(randomFankang.name, randomFankang.color)}反抗-14`;
        const otherFankang = fankangPlayers.filter(p => p.id !== randomFankang.id);
        if (otherFankang.length > 0) {
          msg += `，${otherFankang.map(p => coloredName(p.name, p.color)).join('、')}反抗+2`;
        }
        if (jingongPlayers.length > 0) {
          msg += `，${jingongPlayers.map(p => coloredName(p.name, p.color)).join('、')}进贡-2`;
        }
        const netChange = currentNetChange - otherFankang.length * 2;
        msg += `，${coloredName(current.name, current.color)}${netChange >= 0 ? '+' : ''}${netChange}`;
        
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: msg });
        io.to(baozhengState.currentPlayerId).emit('showEndTurn');
        baozhengState = null;
      } else {
        for (const jp of jingongPlayers) {
          previewMoney(jp.id, -2);
        }
        const totalGain = jingongPlayers.length * 2;
        previewMoney(current.id, totalGain);
        
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `无人反抗，每个人给${coloredName(current.name, current.color)}2，新一轮暴政开始` });
        
        baozhengState.choices = {};
        baozhengState.phase = 'selecting';
        baozhengState.round++;
        
        io.emit('baozhengStart', {
          currentPlayerId: baozhengState.currentPlayerId,
          currentPlayerName: baozhengState.currentPlayerName,
          currentPlayerColor: baozhengState.currentPlayerColor
        });
      }
    }
  });

  socket.on('daoyingChoice', ({ choice }) => {
    if (!daoyingState || daoyingState.phase !== 'selecting') return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt) return;
    
    if (socket.id === daoyingState.currentPlayerId) {
      daoyingState.currentChoice = choice;
      io.to(socket.id).emit('daoyingChoiceMade');
      
      if (daoyingState.hasTarget) {
        daoyingState.phase = 'selectTarget';
        io.emit('daoyingSelectTarget', {
          currentPlayerId: daoyingState.currentPlayerId,
          currentPlayerName: daoyingState.currentPlayerName,
          currentPlayerColor: daoyingState.currentPlayerColor
        });
      } else {
        const current = players.find(p => p.id === daoyingState.currentPlayerId);
        applyDaoyingEffect(current, choice);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}${daoyingEffectText(choice)}` });
        io.to(daoyingState.currentPlayerId).emit('showEndTurn');
        daoyingState = null;
      }
    }
  });

  socket.on('daoyingSelectTargetConfirm', ({ targetId }) => {
    if (!daoyingState || daoyingState.phase !== 'selectTarget') return;
    const current = players.find(p => p.id === socket.id);
    if (!current || current.id !== daoyingState.currentPlayerId) return;
    
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === daoyingState.currentPlayerId) return;
    
    const choice = daoyingState.currentChoice;
    
    withHiddenCheck(current.id, target.id,
      (finalTarget, hiddenMsg) => {
        if (!finalTarget || finalTarget.bankrupt) {
          applyDaoyingEffect(current, choice);
        } else {
          applyDaoyingEffect(current, choice);
          applyDaoyingEffect(finalTarget, choice);
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}和${coloredName(finalTarget?.name || target.name, finalTarget?.color || target.color)}${daoyingEffectText(choice)}` });
        io.to(daoyingState.currentPlayerId).emit('showEndTurn');
        daoyingState = null;
      },
      () => {
        applyDaoyingEffect(current, choice);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的倒影效果被隐藏卡取消了（自身${daoyingEffectText(choice)}）` });
        io.to(daoyingState.currentPlayerId).emit('showEndTurn');
        daoyingState = null;
      },
      (source) => {
        applyDaoyingEffect(source, choice);
        applyDaoyingEffect(source, choice);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `反弹！${coloredName(source.name, source.color)}${daoyingEffectText(choice)}两次` });
        io.to(daoyingState.currentPlayerId).emit('showEndTurn');
        daoyingState = null;
      }
    );
  });

  socket.on('xianzhiConfirm', ({ order }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!xianzhiState || xianzhiState.playerId !== socket.id) return;
    const ordered = order.map(idx => xianzhiState.jiyus[idx]).filter(j => j);
    jiyuQueue = [...ordered, ...jiyuQueue];
    xianzhiState = null;
    io.emit('xianzhiEnd');
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('showEndTurn');
  });

  socket.on('tuisuanConfirm', ({ guess }) => {
    if (!tuisuanState) return;
    if (socket.id === tuisuanState.currentPlayerId) {
      tuisuanState.currentGuess = guess;
    } else if (socket.id === tuisuanState.targetPlayerId) {
      tuisuanState.targetGuess = guess;
    } else {
      return;
    }
    const player = players.find(p => p.id === socket.id);
    io.emit('tuisuanPlayerConfirmed', { playerId: socket.id, playerName: player ? player.name : '' });
    if (tuisuanState.currentGuess !== null && tuisuanState.targetGuess !== null) {
      const W = tuisuanState.W;
      const currentDiff = Math.abs(tuisuanState.currentGuess - W);
      const targetDiff = Math.abs(tuisuanState.targetGuess - W);
      const current = players.find(p => p.id === tuisuanState.currentPlayerId);
      const target = players.find(p => p.id === tuisuanState.targetPlayerId);
      let winner, loser, winnerGuess, loserGuess;
      if (currentDiff <= targetDiff) {
        winner = current;
        loser = target;
        winnerGuess = tuisuanState.currentGuess;
        loserGuess = tuisuanState.targetGuess;
      } else {
        winner = target;
        loser = current;
        winnerGuess = tuisuanState.targetGuess;
        loserGuess = tuisuanState.currentGuess;
      }
      if (winner && loser) {
        previewMoney(winner.id, 13);
        previewMoney(loser.id, -13);
      }
      io.emit('tuisuanEnd', {
        W: W,
        winnerName: winner ? winner.name : '',
        winnerColor: winner ? winner.color : '#fff',
        winnerGuess: winnerGuess,
        loserName: loser ? loser.name : '',
        loserColor: loser ? loser.color : '#fff',
        loserGuess: loserGuess
      });
      tuisuanState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      const cur = players[currentPlayerIndex];
      if (cur) {
        const s = io.sockets.sockets.get(cur.id);
        if (s) s.emit('showEndTurn');
      }
    }
  });

  socket.on('jiandieSelectTargets', ({ targetAId, targetBId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const targetA = players.find(p => p.id === targetAId);
    const targetB = players.find(p => p.id === targetBId);
    if (!targetA || !targetB || targetA.id === targetB.id) return;
    jiandieState = {
      currentPlayerId: current.id,
      currentPlayerName: current.name,
      currentPlayerColor: current.color,
      targetAId: targetA.id,
      targetAName: targetA.name,
      targetAColor: targetA.color,
      targetBId: targetB.id,
      targetBName: targetB.name,
      targetBColor: targetB.color,
      amountA: null,
      amountB: null,
      choiceA: null,
      choiceB: null
    };
    io.emit('jiandieShowPanel', {
      currentPlayerId: current.id,
      currentPlayerName: current.name,
      currentPlayerColor: current.color,
      targetAId: targetA.id,
      targetAName: targetA.name,
      targetAColor: targetA.color,
      targetBId: targetB.id,
      targetBName: targetB.name,
      targetBColor: targetB.color
    });
  });

  socket.on('jiandieAmountConfirm', ({ amountA, amountB }) => {
    if (!jiandieState) return;
    if (socket.id !== jiandieState.currentPlayerId) return;
    if (amountA === amountB) return;
    jiandieState.amountA = amountA;
    jiandieState.amountB = amountB;
    io.emit('jiandiePanelEnd');
    const A = jiandieState.targetAName;
    const B = jiandieState.targetBName;
    io.emit('updateAreaE', { message: `${coloredName(A, jiandieState.targetAColor)}，${coloredName(B, jiandieState.targetBColor)}请选择，少的选收下：给双倍的钱；多的选退回：随机地产-1（没地产-30）` });
    const sA = io.sockets.sockets.get(jiandieState.targetAId);
    if (sA) sA.emit('jiandieChoice', { targetName: A, targetColor: jiandieState.targetAColor });
    const sB = io.sockets.sockets.get(jiandieState.targetBId);
    if (sB) sB.emit('jiandieChoice', { targetName: B, targetColor: jiandieState.targetBColor });
  });

  socket.on('jiandieChoiceConfirm', ({ choice }) => {
    if (!jiandieState) return;
    if (socket.id === jiandieState.targetAId) {
      jiandieState.choiceA = choice;
    } else if (socket.id === jiandieState.targetBId) {
      jiandieState.choiceB = choice;
    } else {
      return;
    }
    const player = players.find(p => p.id === socket.id);
    io.emit('jiandieChoiceMade', { playerId: socket.id, playerName: player ? player.name : '', choice });
    if (jiandieState.choiceA !== null && jiandieState.choiceB !== null) {
      const current = players.find(p => p.id === jiandieState.currentPlayerId);
      const targetA = players.find(p => p.id === jiandieState.targetAId);
      const targetB = players.find(p => p.id === jiandieState.targetBId);
      const AA = jiandieState.amountA;
      const BB = jiandieState.amountB;
      let eMsg = '';
      if (AA < BB) {
        let aResult = '';
        if (jiandieState.choiceA === '收下') {
          const C = AA * 2;
          if (targetA && current) {
            previewMoney(targetA.id, -C);
            previewMoney(current.id, C);
          }
          aResult = `${coloredName(jiandieState.targetAName, jiandieState.targetAColor)}收下给${coloredName(jiandieState.currentPlayerName, jiandieState.currentPlayerColor)}${C}`;
        } else {
          aResult = `${coloredName(jiandieState.targetAName, jiandieState.targetAColor)}退回`;
        }
        let bResult = '';
        if (jiandieState.choiceB === '退回') {
          if (targetB) {
            const bProps = board.filter(s => s.isProperty && s.owner === targetB.id);
            if (bProps.length > 0) {
              const prop = bProps[Math.floor(Math.random() * bProps.length)];
              const lostName = prop.name;
              prop.houseLevel = 0;
              prop.owner = null;
              bResult = `${coloredName(jiandieState.targetBName, jiandieState.targetBColor)}退回失去${lostName}`;
            } else {
              previewMoney(targetB.id, -30);
              bResult = `${coloredName(jiandieState.targetBName, jiandieState.targetBColor)}退回-30`;
            }
          }
        } else {
          if (targetB && current) {
            previewMoney(targetB.id, BB);
            previewMoney(current.id, -BB);
          }
          bResult = `${coloredName(jiandieState.targetBName, jiandieState.targetBColor)}收下`;
        }
        eMsg = `${coloredName(jiandieState.currentPlayerName, jiandieState.currentPlayerColor)}给${coloredName(jiandieState.targetAName, jiandieState.targetAColor)}$${AA}少，${aResult}；${coloredName(jiandieState.currentPlayerName, jiandieState.currentPlayerColor)}给${coloredName(jiandieState.targetBName, jiandieState.targetBColor)}$${BB}多，${bResult}`;
      } else {
        let bResult = '';
        if (jiandieState.choiceB === '收下') {
          const C = BB * 2;
          if (targetB && current) {
            previewMoney(targetB.id, -C);
            previewMoney(current.id, C);
          }
          bResult = `${coloredName(jiandieState.targetBName, jiandieState.targetBColor)}收下给${coloredName(jiandieState.currentPlayerName, jiandieState.currentPlayerColor)}${C}`;
        } else {
          bResult = `${coloredName(jiandieState.targetBName, jiandieState.targetBColor)}退回`;
        }
        let aResult = '';
        if (jiandieState.choiceA === '退回') {
          if (targetA) {
            const aProps = board.filter(s => s.isProperty && s.owner === targetA.id);
            if (aProps.length > 0) {
              const prop = aProps[Math.floor(Math.random() * aProps.length)];
              const lostName = prop.name;
              prop.houseLevel = 0;
              prop.owner = null;
              aResult = `${coloredName(jiandieState.targetAName, jiandieState.targetAColor)}退回失去${lostName}`;
            } else {
              previewMoney(targetA.id, -30);
              aResult = `${coloredName(jiandieState.targetAName, jiandieState.targetAColor)}退回-30`;
            }
          }
        } else {
          if (targetA && current) {
            previewMoney(targetA.id, AA);
            previewMoney(current.id, -AA);
          }
          aResult = `${coloredName(jiandieState.targetAName, jiandieState.targetAColor)}收下`;
        }
        eMsg = `${coloredName(jiandieState.currentPlayerName, jiandieState.currentPlayerColor)}给${coloredName(jiandieState.targetBName, jiandieState.targetBColor)}$${BB}少，${bResult}；${coloredName(jiandieState.currentPlayerName, jiandieState.currentPlayerColor)}给${coloredName(jiandieState.targetAName, jiandieState.targetAColor)}$${AA}多，${aResult}`;
      }
      io.emit('jiandieEnd');
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: eMsg });
      jiandieState = null;
      const cur = players[currentPlayerIndex];
      if (cur) {
        const s = io.sockets.sockets.get(cur.id);
        if (s) s.emit('showEndTurn');
      }
    }
  });

  socket.on('cunqianConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (current.money < 40) {
      socket.emit('error', '金钱不足');
      return;
    }
    previewMoney(current.id, -40);
    if (!current.cunqianList) current.cunqianList = [];
    current.cunqianList.push(10);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}存入40，10轮后+50` });
    io.emit('cunqianConfirmed', { playerId: current.id });
    socket.emit('showEndTurn');
  });

  socket.on('dezhouConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const otherActive = players.filter(p => !p.bankrupt && p.id !== current.id);
    if (otherActive.length === 0) {
      socket.emit('error', '没有其他玩家');
      return;
    }
    const randomOpponent = otherActive[Math.floor(Math.random() * otherActive.length)];
    startTexasHoldem(current.id, randomOpponent.id);
  });

  socket.on('lunciConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const otherActive = players.filter(p => !p.bankrupt && p.id !== current.id);
    if (otherActive.length === 0) {
      socket.emit('error', '没有其他玩家');
      return;
    }
    const cards = drawPukepaiCards(6);
    lunciState = {
      currentPlayerId: current.id,
      currentPlayerName: current.name,
      currentPlayerColor: current.color,
      targetId: null,
      targetName: null,
      targetColor: null,
      cards: cards,
      currentCards: [],
      targetCards: [],
      priorityPlayerId: current.id,
      currentSelection: null,
      targetSelection: null,
      phase: 'selectingTarget',
      round: 1
    };
    io.emit('lunciSelectTarget', {
      currentPlayerId: current.id,
      currentPlayerName: current.name,
      currentPlayerColor: current.color
    });
  });

  socket.on('lunciSelectTargetConfirm', ({ targetId }) => {
    if (!lunciState || lunciState.phase !== 'selectingTarget') return;
    const current = players.find(p => p.id === socket.id);
    if (!current || current.id !== lunciState.currentPlayerId) return;
    
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === lunciState.currentPlayerId) return;
    
    withHiddenCheck(current.id, target.id,
      (finalTarget, hiddenMsg) => {
        lunciState.targetId = finalTarget.id;
        lunciState.targetName = finalTarget.name;
        lunciState.targetColor = finalTarget.color;
        lunciState.phase = 'selectingCard';
        lunciState.currentSelection = null;
        lunciState.targetSelection = null;
        
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('lunciStart', {
          currentPlayerId: lunciState.currentPlayerId,
          currentPlayerName: lunciState.currentPlayerName,
          currentPlayerColor: lunciState.currentPlayerColor,
          targetId: lunciState.targetId,
          targetName: lunciState.targetName,
          targetColor: lunciState.targetColor,
          cards: lunciState.cards,
          currentCards: lunciState.currentCards,
          targetCards: lunciState.targetCards,
          priorityPlayerId: lunciState.priorityPlayerId,
          round: lunciState.round
        });
      },
      () => {
        const playerId = lunciState.currentPlayerId;
        lunciState = null;
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的轮次被隐藏卡取消了` });
        io.to(playerId).emit('showEndTurn');
      }
    );
  });

  socket.on('lunciSelectCard', ({ cardIndex }) => {
    if (!lunciState || lunciState.phase !== 'selectingCard') return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt) return;
    if (player.id !== lunciState.currentPlayerId && player.id !== lunciState.targetId) return;
    
    if (player.id === lunciState.currentPlayerId) {
      lunciState.currentSelection = cardIndex;
    } else {
      lunciState.targetSelection = cardIndex;
    }
    
    io.to(player.id).emit('lunciCardSelected', { playerId: player.id, cardIndex });
    
    if (lunciState.currentSelection !== null && lunciState.targetSelection !== null) {
      lunciState.phase = 'resolving';
      const currentCard = lunciState.cards[lunciState.currentSelection];
      const targetCard = lunciState.cards[lunciState.targetSelection];
      
      let message = '';
      
      if (lunciState.currentSelection === lunciState.targetSelection) {
        const priorityPlayer = players.find(p => p.id === lunciState.priorityPlayerId);
        if (lunciState.priorityPlayerId === lunciState.currentPlayerId) {
          lunciState.currentCards.push(currentCard);
        } else {
          lunciState.targetCards.push(currentCard);
        }
        const otherPlayer = lunciState.priorityPlayerId === lunciState.currentPlayerId ? lunciState.targetName : lunciState.currentPlayerName;
        message = `${coloredName(lunciState.priorityPlayerId === lunciState.currentPlayerId ? lunciState.currentPlayerName : lunciState.targetName, lunciState.priorityPlayerId === lunciState.currentPlayerId ? lunciState.currentPlayerColor : lunciState.targetColor)}获得${currentCard.rank}，${coloredName(otherPlayer, lunciState.priorityPlayerId === lunciState.currentPlayerId ? lunciState.targetColor : lunciState.currentPlayerColor)}获得0，${coloredName(otherPlayer, lunciState.priorityPlayerId === lunciState.currentPlayerId ? lunciState.targetColor : lunciState.currentPlayerColor)}下一轮先获得`;
        lunciState.priorityPlayerId = lunciState.priorityPlayerId === lunciState.currentPlayerId ? lunciState.targetId : lunciState.currentPlayerId;
      } else {
        lunciState.currentCards.push(currentCard);
        lunciState.targetCards.push(targetCard);
        
        if (currentCard.rank < targetCard.rank) {
          lunciState.priorityPlayerId = lunciState.currentPlayerId;
        } else if (targetCard.rank < currentCard.rank) {
          lunciState.priorityPlayerId = lunciState.targetId;
        }
        
        const priorityName = lunciState.priorityPlayerId === lunciState.currentPlayerId ? lunciState.currentPlayerName : lunciState.targetName;
        const priorityColor = lunciState.priorityPlayerId === lunciState.currentPlayerId ? lunciState.currentPlayerColor : lunciState.targetColor;
        message = `${coloredName(lunciState.currentPlayerName, lunciState.currentPlayerColor)}获得${currentCard.rank}，${coloredName(lunciState.targetName, lunciState.targetColor)}获得${targetCard.rank}，${coloredName(priorityName, priorityColor)}下一轮先获得`;
      }
      
      const remainingCards = lunciState.cards.filter((_, i) => i !== lunciState.currentSelection && i !== lunciState.targetSelection);
      lunciState.cards = remainingCards;
      lunciState.currentSelection = null;
      lunciState.targetSelection = null;
      lunciState.round++;
      
      if (lunciState.cards.length === 0) {
        const currentSum = lunciState.currentCards.reduce((s, c) => s + c.rank, 0);
        const targetSum = lunciState.targetCards.reduce((s, c) => s + c.rank, 0);
        
        lunciState.phase = 'finished';
        
        let resultMessage = '';
        let areaEMessage = '';
        if (currentSum > targetSum) {
          previewMoney(lunciState.currentPlayerId, 13);
          previewMoney(lunciState.targetId, -13);
          resultMessage = `${coloredName(lunciState.currentPlayerName, lunciState.currentPlayerColor)}获胜`;
          areaEMessage = `${coloredName(lunciState.currentPlayerName, lunciState.currentPlayerColor)}的点数和${currentSum}胜+13，${coloredName(lunciState.targetName, lunciState.targetColor)}的点数和${targetSum}败-13`;
        } else if (targetSum > currentSum) {
          previewMoney(lunciState.targetId, 13);
          previewMoney(lunciState.currentPlayerId, -13);
          resultMessage = `${coloredName(lunciState.targetName, lunciState.targetColor)}获胜`;
          areaEMessage = `${coloredName(lunciState.targetName, lunciState.targetColor)}的点数和${targetSum}胜+13，${coloredName(lunciState.currentPlayerName, lunciState.currentPlayerColor)}的点数和${currentSum}败-13`;
        } else {
          resultMessage = `平局`;
          areaEMessage = `${coloredName(lunciState.currentPlayerName, lunciState.currentPlayerColor)}的点数和${currentSum}，${coloredName(lunciState.targetName, lunciState.targetColor)}的点数和${targetSum}，平局`;
        }
        
        lunciState.areaEMessage = areaEMessage;
        
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('lunciResult', {
          currentPlayerId: lunciState.currentPlayerId,
          currentPlayerName: lunciState.currentPlayerName,
          currentPlayerColor: lunciState.currentPlayerColor,
          targetId: lunciState.targetId,
          targetName: lunciState.targetName,
          targetColor: lunciState.targetColor,
          currentCards: lunciState.currentCards,
          targetCards: lunciState.targetCards,
          currentSum,
          targetSum,
          finished: true,
          resultMessage
        });
        return;
      }
      
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      lunciState.phase = 'selectingCard';
      io.emit('lunciNextRound', {
        currentPlayerId: lunciState.currentPlayerId,
        currentPlayerName: lunciState.currentPlayerName,
        currentPlayerColor: lunciState.currentPlayerColor,
        targetId: lunciState.targetId,
        targetName: lunciState.targetName,
        targetColor: lunciState.targetColor,
        cards: lunciState.cards,
        currentCards: lunciState.currentCards,
        targetCards: lunciState.targetCards,
        priorityPlayerId: lunciState.priorityPlayerId,
        round: lunciState.round
      });
    }
  });

  socket.on('lunciClose', () => {
    if (!lunciState) return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.id !== lunciState.currentPlayerId) return;
    if (lunciState.areaEMessage) {
      io.emit('updateAreaE', { message: lunciState.areaEMessage });
    }
    io.emit('lunciClosed');
    lunciState = null;
    initPukepaiDeck();
    shufflePukepaiDeck();
  });

  socket.on('qiyuXinlixueChoice', ({ choice }) => {
    if (!xinlixueState || xinlixueState.phase !== 'selecting') return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt) return;
    
    xinlixueState.choices[socket.id] = choice;
    
    io.to(socket.id).emit('qiyuXinlixueChoiceMade');
    
    const activePlayers = players.filter(p => !p.bankrupt);
    const allChosen = activePlayers.every(p => xinlixueState.choices[p.id] !== undefined);
    
    if (allChosen) {
      xinlixueState.phase = 'result';
      
      const current = players.find(p => p.id === xinlixueState.currentPlayerId);
      const currentChoice = xinlixueState.choices[xinlixueState.currentPlayerId];
      const amount = parseInt(currentChoice);
      
      const correctPlayers = [];
      const wrongPlayersWithChoice = [];
      
      for (const [pid, c] of Object.entries(xinlixueState.choices)) {
        if (pid === xinlixueState.currentPlayerId) continue;
        const p = players.find(pl => pl.id === pid);
        if (c === currentChoice) {
          correctPlayers.push(p);
        } else {
          wrongPlayersWithChoice.push({ player: p, choice: c });
        }
      }
      
      for (const cp of correctPlayers) {
        const give = Math.min(amount, current.money);
        if (give > 0) {
          previewMoney(current.id, -give);
          previewMoney(cp.id, give);
        }
      }
      
      for (const { player: wp } of wrongPlayersWithChoice) {
        const give = Math.min(amount, wp.money);
        if (give > 0) {
          previewMoney(wp.id, -give);
          previewMoney(current.id, give);
        }
      }
      
      let msg = '';
      if (wrongPlayersWithChoice.length > 0) {
        msg += wrongPlayersWithChoice.map(({ player: p, choice: c }) => `${coloredName(p.name, p.color)}猜${c}猜错给${coloredName(current.name, current.color)}${amount}`).join('，');
      }
      if (correctPlayers.length > 0) {
        if (msg) msg += '，';
        msg += `${coloredName(current.name, current.color)}给猜对的${correctPlayers.map(p => coloredName(p.name, p.color)).join('、')}${amount}`;
      }
      
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: msg });
      io.to(xinlixueState.currentPlayerId).emit('showEndTurn');
      xinlixueState = null;
    }
  });

  socket.on('qiyuLianhuanjiChoice', ({ choice }) => {
    if (!lianhuanjiState || lianhuanjiState.phase !== 'selecting') return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt) return;
    
    if (socket.id === lianhuanjiState.currentPlayerId) {
      lianhuanjiState.currentChoice = choice;
    } else if (socket.id === lianhuanjiState.nextPlayerId) {
      lianhuanjiState.nextChoice = choice;
    }
    
    io.to(socket.id).emit('qiyuLianhuanjiChoiceMade');
    
    if (lianhuanjiState.currentChoice !== null && lianhuanjiState.nextChoice !== null) {
      lianhuanjiState.phase = 'result';
      
      const current = players.find(p => p.id === lianhuanjiState.currentPlayerId);
      const nextPlayer = players.find(p => p.id === lianhuanjiState.nextPlayerId);
      const currentNum = parseInt(lianhuanjiState.currentChoice);
      const nextNum = parseInt(lianhuanjiState.nextChoice);
      
      if (currentNum === nextNum) {
        const gain = Math.min(currentNum, current.money);
        if (gain > 0) {
          previewMoney(current.id, -gain);
          previewMoney(nextPlayer.id, gain);
        }
        
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(nextPlayer.name, nextPlayer.color)}猜对，获得${coloredName(current.name, current.color)}${currentNum}` });
        io.to(lianhuanjiState.originalPlayerId).emit('showEndTurn');
        lianhuanjiState = null;
      } else {
        const gain = Math.min(currentNum, nextPlayer.money);
        if (gain > 0) {
          previewMoney(nextPlayer.id, -gain);
          previewMoney(current.id, gain);
        }
        
        const nextPlayerIdx = players.findIndex(p => p.id === lianhuanjiState.nextPlayerId);
        let newNextIdx = (nextPlayerIdx + 1) % players.length;
        let newNext = players[newNextIdx];
        while (newNext.bankrupt && newNextIdx !== nextPlayerIdx) {
          newNextIdx = (newNextIdx + 1) % players.length;
          newNext = players[newNextIdx];
        }
        
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(nextPlayer.name, nextPlayer.color)}猜测的${nextNum}猜错了，给${coloredName(current.name, current.color)}${currentNum}，请让${coloredName(newNext.name, newNext.color)}猜` });
        
        lianhuanjiState = {
          currentPlayerId: nextPlayer.id,
          currentPlayerName: nextPlayer.name,
          currentPlayerColor: nextPlayer.color,
          currentChoice: null,
          nextPlayerId: newNext.id,
          nextPlayerName: newNext.name,
          nextPlayerColor: newNext.color,
          nextChoice: null,
          phase: 'selecting',
          originalPlayerId: lianhuanjiState.originalPlayerId
        };
        
        io.emit('qiyuLianhuanjiContinue', {
          currentPlayerId: lianhuanjiState.currentPlayerId,
          currentPlayerName: lianhuanjiState.currentPlayerName,
          currentPlayerColor: lianhuanjiState.currentPlayerColor,
          nextPlayerId: lianhuanjiState.nextPlayerId,
          nextPlayerName: lianhuanjiState.nextPlayerName,
          nextPlayerColor: lianhuanjiState.nextPlayerColor
        });
      }
    }
  });

  socket.on('qiyuShoumaiConfirm', ({ diceValue }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    let totalCost = 0;
    players.forEach(p => {
      if (p.id !== current.id && !p.bankrupt) {
        totalCost += 3;
      }
    });
    
    if (current.money < totalCost) {
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}金钱不足，收买失败` });
      return;
    }
    
    players.forEach(p => {
      if (p.id !== current.id && !p.bankrupt) {
        previewMoney(p.id, 3);
      }
    });
    previewMoney(current.id, -totalCost);

    current.shoumaiDice = diceValue;
    
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}给每人3，下回合掷${diceValue}` });
    io.to(current.id).emit('showEndTurn');
    shoumaiState = null;
  });

  // 瞒天过海：玩家选择点数
  socket.on('mantianGuohaiChoose', ({ diceValue }) => {
    if (!mantianGuohaiState) return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt) return;
    
    // 当前玩家选择后，通知其他玩家开始猜测
    if (mantianGuohaiState.phase === 'currentPlayerSelect' && socket.id === mantianGuohaiState.currentPlayerId) {
      mantianGuohaiState.choices[socket.id] = diceValue;
      mantianGuohaiState.phase = 'othersSelect';
      
      io.to(socket.id).emit('clearAreaF');
      
      // 通知其他玩家开始猜测
      const otherPlayers = players.filter(p => !p.bankrupt && p.id !== mantianGuohaiState.currentPlayerId);
      otherPlayers.forEach(p => {
        io.to(p.id).emit('mantianGuohaiOthersSelect', {
          currentPlayerId: mantianGuohaiState.currentPlayerId,
          currentPlayerName: mantianGuohaiState.currentPlayerName,
          currentPlayerColor: mantianGuohaiState.currentPlayerColor
        });
      });
      
      io.emit('updateAreaE', { message: `请猜测${coloredName(mantianGuohaiState.currentPlayerName, mantianGuohaiState.currentPlayerColor)}的点数，猜对+9` });
      return;
    }
    
    // 其他玩家选择
    if (mantianGuohaiState.phase === 'othersSelect') {
      mantianGuohaiState.choices[socket.id] = diceValue;
      mantianGuohaiState.waitingPlayers = mantianGuohaiState.waitingPlayers.filter(id => id !== socket.id);
      
      io.to(socket.id).emit('clearAreaF');
      
      if (mantianGuohaiState.waitingPlayers.length === 0) {
        const currentPlayerChoice = mantianGuohaiState.choices[mantianGuohaiState.currentPlayerId];
        const correctPlayers = [];
        
        for (const [playerId, choice] of Object.entries(mantianGuohaiState.choices)) {
          if (playerId !== mantianGuohaiState.currentPlayerId && choice === currentPlayerChoice) {
            correctPlayers.push(players.find(p => p.id === playerId));
          }
        }
        
        if (correctPlayers.length > 0) {
          correctPlayers.forEach(p => {
            previewMoney(p.id, 9);
          });
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          const names = correctPlayers.map(p => coloredName(p.name, p.color)).join('，');
          io.emit('updateAreaE', { message: `${names}猜对${currentPlayerChoice}+9` });
          io.to(mantianGuohaiState.currentPlayerId).emit('showEndTurn');
        } else {
          const current = players.find(p => p.id === mantianGuohaiState.currentPlayerId);
          if (current) {
            previewMoney(current.id, 9);
            current.shoumaiDice = currentPlayerChoice;
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
            io.emit('updateAreaE', { message: `无人猜对，${coloredName(current.name, current.color)}+9，下回合掷${currentPlayerChoice}` });
            io.to(current.id).emit('mantianGuohaiShowDice', { diceValue: currentPlayerChoice });
            io.to(current.id).emit('showEndTurn');
          }
        }
        mantianGuohaiState = null;
      }
    }
  });

  // 合作任务：当前玩家选择目标
  socket.on('hezuorenwuSelectTarget', ({ targetId }) => {
    if (!hezuorenwuState || hezuorenwuState.phase !== 'selectTarget') return;
    if (socket.id !== hezuorenwuState.currentPlayerId) return;
    
    const current = players.find(p => p.id === hezuorenwuState.currentPlayerId);
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;
    
    withHiddenCheck(current.id, target.id,
      (finalTarget) => {
        hezuorenwuState.targetId = finalTarget.id;
        hezuorenwuState.targetName = finalTarget.name;
        hezuorenwuState.targetColor = finalTarget.color;
        hezuorenwuState.phase = 'inputMoney';
        
        io.to(hezuorenwuState.currentPlayerId).emit('hezuorenwuShowPanel', {
          isCurrentPlayer: true,
          targetName: finalTarget.name,
          targetColor: finalTarget.color
        });
        io.to(finalTarget.id).emit('hezuorenwuShowPanel', {
          isCurrentPlayer: false,
          currentName: current.name,
          currentColor: current.color
        });
      },
      () => {
        const playerId = hezuorenwuState.currentPlayerId;
        hezuorenwuState = null;
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的合作任务被隐藏卡取消了` });
        io.to(playerId).emit('showEndTurn');
      }
    );
  });

  // 合作任务：玩家输入金额
  socket.on('hezuorenwuInputMoney', ({ money }) => {
    if (!hezuorenwuState || hezuorenwuState.phase !== 'inputMoney') return;
    const player = players.find(p => p.id === socket.id);
    if (!player) return;
    
    if (socket.id === hezuorenwuState.currentPlayerId) {
      hezuorenwuState.currentPlayerMoney = money;
      io.to(socket.id).emit('hezuorenwuWaiting');
    } else if (socket.id === hezuorenwuState.targetId) {
      hezuorenwuState.targetPlayerMoney = money;
      io.to(socket.id).emit('hezuorenwuWaiting');
    }
    
    if (hezuorenwuState.currentPlayerMoney !== null && hezuorenwuState.targetPlayerMoney !== null) {
      const A = hezuorenwuState.currentPlayerMoney;
      const B = hezuorenwuState.targetPlayerMoney;
      const W = Math.floor(Math.random() * 11) + 10;
      
      const current = players.find(p => p.id === hezuorenwuState.currentPlayerId);
      const target = players.find(p => p.id === hezuorenwuState.targetId);
      
      if (W > A + B) {
        if (current) {
          previewMoney(current.id, -A);
        }
        if (target) {
          previewMoney(target.id, -B);
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `随机数为${W}，${coloredName(current.name, current.color)}-${A}，${coloredName(target.name, target.color)}-${B}` });
      } else {
        const C = W + 3 - A;
        const D = W + 3 - B;
        if (current) {
          previewMoney(current.id, C);
        }
        if (target) {
          previewMoney(target.id, D);
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `随机数为${W}≤${A}+${B}，${coloredName(current.name, current.color)}+${C}，${coloredName(target.name, target.color)}+${D}` });
      }
      
      io.to(hezuorenwuState.currentPlayerId).emit('hezuorenwuClose');
      io.to(hezuorenwuState.targetId).emit('hezuorenwuClose');
      io.to(hezuorenwuState.currentPlayerId).emit('showEndTurn');
      hezuorenwuState = null;
    }
  });

  // 迷惑：选择目标
  socket.on('meihuoSelectTarget', ({ targetId }) => {
    if (!meihuoState || meihuoState.phase !== 'selectTarget') return;
    if (socket.id !== meihuoState.currentPlayerId) return;
    
    const current = players.find(p => p.id === meihuoState.currentPlayerId);
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;
    
    withHiddenCheck(current.id, target.id,
      (finalTarget) => {
        meihuoState.targetId = finalTarget.id;
        meihuoState.targetName = finalTarget.name;
        meihuoState.targetColor = finalTarget.color;
        meihuoState.phase = 'selectDice';
        
        io.to(socket.id).emit('meihuoSelectDice');
      },
      () => {
        const playerId = meihuoState.currentPlayerId;
        meihuoState = null;
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的迷惑被隐藏卡取消了` });
        io.to(playerId).emit('showEndTurn');
      }
    );
  });

  // 迷惑：当前玩家选择点数W
  socket.on('meihuoChooseDice', ({ diceValue }) => {
    if (!meihuoState || meihuoState.phase !== 'selectDice') return;
    if (socket.id !== meihuoState.currentPlayerId) return;
    
    // 生成两个随机点数（不同于W）
    const availableDice = [1, 2, 3, 4, 5, 6].filter(d => d !== diceValue);
    const randomIdx1 = Math.floor(Math.random() * availableDice.length);
    const randomDice1 = availableDice[randomIdx1];
    availableDice.splice(randomIdx1, 1);
    const randomDice2 = availableDice[Math.floor(Math.random() * availableDice.length)];
    
    // 随机排列三个点数
    const shuffled = [diceValue, randomDice1, randomDice2].sort(() => Math.random() - 0.5);
    
    meihuoState.chosenDice = diceValue;
    meihuoState.randomDice1 = randomDice1;
    meihuoState.randomDice2 = randomDice2;
    meihuoState.shuffledDice = shuffled;
    meihuoState.phase = 'targetGuess';
    
    io.emit('meihuoShowDiceOptions', {
      currentPlayerId: meihuoState.currentPlayerId,
      currentPlayerName: meihuoState.currentPlayerName,
      currentPlayerColor: meihuoState.currentPlayerColor,
      targetId: meihuoState.targetId,
      targetName: meihuoState.targetName,
      targetColor: meihuoState.targetColor,
      diceOptions: shuffled
    });
    
    io.emit('updateAreaE', { message: `${coloredName(meihuoState.targetName, meihuoState.targetColor)}，请猜测${coloredName(meihuoState.currentPlayerName, meihuoState.currentPlayerColor)}交给你的点数` });
  });

  // 迷惑：目标猜测点数
  socket.on('meihuoGuessDice', ({ diceValue }) => {
    if (!meihuoState || meihuoState.phase !== 'targetGuess') return;
    if (socket.id !== meihuoState.targetId) return;
    
    const current = players.find(p => p.id === meihuoState.currentPlayerId);
    const target = players.find(p => p.id === meihuoState.targetId);
    
    if (diceValue === meihuoState.chosenDice) {
      // 猜对了
      meihuoState.phase = 'selectRemaining';
      
      // 删除W选项，剩下两个点数
      const remainingDice = meihuoState.shuffledDice.filter(d => d !== meihuoState.chosenDice);
      
      io.emit('updateAreaE', { message: `${coloredName(meihuoState.targetName, meihuoState.targetColor)}猜${meihuoState.chosenDice}对了，请选择1个作为你下回合点数` });
      io.to(meihuoState.targetId).emit('meihuoSelectRemaining', { remainingDice });
      io.to(meihuoState.currentPlayerId).emit('clearAreaF');
    } else {
      // 猜错了
      meihuoState.phase = 'finished';
      
      // 目标给当前玩家13
      if (target && target.money >= 13) {
        previewMoney(target.id, -13);
        previewMoney(current.id, 13);
      } else if (target) {
        previewMoney(target.id, -target.money);
        current.money += target.money;
        target.money = 0;
      }
      
      // 目标下回合点数为W
      target.shoumaiDice = meihuoState.chosenDice;
      
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(meihuoState.targetName, meihuoState.targetColor)}猜测${diceValue}给${coloredName(meihuoState.currentPlayerName, meihuoState.currentPlayerColor)}13，${meihuoState.chosenDice}作为下回合点数` });
      io.to(meihuoState.targetId).emit('meihuoShowDiceIcon', { diceValue: meihuoState.chosenDice });
      io.emit('clearAreaF');
      io.to(meihuoState.currentPlayerId).emit('showEndTurn');
      meihuoState = null;
    }
  });

  // 迷惑：目标选择剩余点数作为下回合点数
  socket.on('meihuoChooseRemaining', ({ diceValue }) => {
    if (!meihuoState || meihuoState.phase !== 'selectRemaining') return;
    if (socket.id !== meihuoState.targetId) return;
    
    const target = players.find(p => p.id === meihuoState.targetId);
    if (target) {
      target.shoumaiDice = diceValue;
    }
    
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(meihuoState.targetName, meihuoState.targetColor)}选择了${diceValue}作为下回合点数` });
    io.to(meihuoState.targetId).emit('meihuoShowDiceIcon', { diceValue });
    io.emit('clearAreaF');
    io.to(meihuoState.currentPlayerId).emit('showEndTurn');
    meihuoState = null;
  });

  // 打猎：开始游戏（显示面板）
  socket.on('dalieBegin', () => {
    if (!dalieState || socket.id !== dalieState.currentPlayerId) return;
    dalieState.gameStarted = true;
    
    io.emit('dalieGameStart', { 
      currentPlayerId: dalieState.currentPlayerId,
      currentPlayerName: dalieState.currentPlayerName,
      currentPlayerColor: dalieState.currentPlayerColor
    });
  });

  // 打猎：点击开始按钮后开始计时和刷新
  socket.on('dalieStartGame', () => {
    if (!dalieState || socket.id !== dalieState.currentPlayerId) return;
    if (dalieState.timerStarted) return;
    dalieState.timerStarted = true;
    dalieState.timeLeft = 20;
    
    // 通知所有玩家游戏已开始
    io.emit('dalieGameStarted');
    
    // 服务器端刷新格子并发送给所有玩家
    function refreshDalieGrid() {
      if (!dalieState || dalieState.gameOver) return;
      const gridData = [];
      for (let i = 0; i < 40; i++) {
        const rand = Math.random() * 100;
        let type = '';
        if (rand < 1) type = 'dl1';
        else if (rand < 11) type = 'dl2';
        else if (rand < 16) type = 'dl3';
        else if (rand < 21) type = 'dl4';
        gridData.push(type);
      }
      dalieState.gridData = gridData;
      io.emit('dalieGridRefresh', { gridData });
    }
    
    refreshDalieGrid();
    dalieRefreshTimer = setInterval(refreshDalieGrid, 1500);
    
    // 服务器端计时
    const timeTimer = setInterval(() => {
      if (!dalieState || dalieState.gameOver) {
        clearInterval(timeTimer);
        return;
      }
      dalieState.timeLeft -= 0.1;
      io.emit('dalieTimeUpdate', { timeLeft: dalieState.timeLeft });
      if (dalieState.timeLeft <= 0) {
        clearInterval(timeTimer);
        clearInterval(dalieRefreshTimer);
        dalieState.gameOver = true;
        
        const current = players.find(p => p.id === dalieState.currentPlayerId);
        if (current) {
          const A = Math.floor(dalieState.score / 10);
          if (A > 0) {
            previewMoney(current.id, A);
          }
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `${coloredName(dalieState.currentPlayerName, dalieState.currentPlayerColor)}打猎+${A}` });
        }
        io.emit('dalieGameOver', { hitHuman: false, score: dalieState.score });
        io.to(dalieState.currentPlayerId).emit('showEndTurn');
        dalieState = null;
      }
    }, 100);
  });

  // 打猎：点击格子
  socket.on('dalieClickCell', ({ cellIndex, cellType }) => {
    if (!dalieState || dalieState.gameOver) return;
    if (socket.id !== dalieState.currentPlayerId) return;
    
    if (cellType === 'dl1') {
      // 老虎 +40
      dalieState.score += 40;
      io.emit('dalieCellResult', { cellIndex, result: 'fenmu', score: dalieState.score });
    } else if (cellType === 'dl2') {
      // 黑牛 +2
      dalieState.score += 2;
      io.emit('dalieCellResult', { cellIndex, result: 'fenmu', score: dalieState.score });
    } else if (cellType === 'dl3') {
      // 虫子 +5
      dalieState.score += 5;
      io.emit('dalieCellResult', { cellIndex, result: 'fenmu', score: dalieState.score });
    } else if (cellType === 'dl4') {
      // 人 -14，游戏结束
      clearInterval(dalieRefreshTimer);
      dalieState.hitHuman = true;
      dalieState.gameOver = true;
      io.emit('dalieCellResult', { cellIndex, result: 'human', score: dalieState.score });
    }
  });

  // 打猎：时间结束
  socket.on('dalieTimeEnd', () => {
    if (!dalieState || dalieState.gameOver) return;
    dalieState.gameOver = true;
    
    const current = players.find(p => p.id === dalieState.currentPlayerId);
    if (current) {
      const A = Math.floor(dalieState.score / 10);
      if (A > 0) {
        previewMoney(current.id, A);
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(dalieState.currentPlayerName, dalieState.currentPlayerColor)}打猎+${A}` });
    }
    io.emit('dalieGameOver', { hitHuman: false, score: dalieState.score });
    io.to(dalieState.currentPlayerId).emit('showEndTurn');
    dalieState = null;
  });

  // 打猎：点击人后结束
  socket.on('dalieHitHumanEnd', () => {
    if (!dalieState) return;
    
    const current = players.find(p => p.id === dalieState.currentPlayerId);
    if (current) {
      previewMoney(current.id, -14);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(dalieState.currentPlayerName, dalieState.currentPlayerColor)}打伤人-14` });
    }
    io.emit('daliePanelClose');
    io.to(dalieState.currentPlayerId).emit('showEndTurn');
    dalieState = null;
  });

  // 打猎：关闭面板
  socket.on('dalieClose', () => {
    io.emit('daliePanelClose');
  });

  // 精算：开始游戏（显示面板）
  socket.on('jingsuanBegin', () => {
    if (!jingsuanState || socket.id !== jingsuanState.currentPlayerId) return;
    jingsuanState.gameStarted = true;
    
    io.emit('jingsuanGameStart', {
      currentPlayerId: jingsuanState.currentPlayerId,
      currentPlayerName: jingsuanState.currentPlayerName,
      currentPlayerColor: jingsuanState.currentPlayerColor,
      cards: jingsuanState.cards,
      upperCards: jingsuanState.upperCards,
      topZone: jingsuanState.topZone,
      bottomZone: jingsuanState.bottomZone
    });
  });

  // 精算：开始游戏
  socket.on('jingsuanStartGame', () => {
    if (!jingsuanState || socket.id !== jingsuanState.currentPlayerId) return;
    if (jingsuanState.timerStarted) return;
    jingsuanState.timerStarted = true;
    jingsuanState.gameStarted = true;
    jingsuanState.timeLeft = 18;
    
    io.emit('jingsuanGameStarted', {
      currentPlayerId: jingsuanState.currentPlayerId
    });
    
    // 开始计时
    const timeTimer = setInterval(() => {
      if (!jingsuanState || jingsuanState.gameOver) {
        clearInterval(timeTimer);
        return;
      }
      jingsuanState.timeLeft -= 0.1;
      io.emit('jingsuanTimeUpdate', { timeLeft: jingsuanState.timeLeft });
      if (jingsuanState.timeLeft <= 0) {
        clearInterval(timeTimer);
        jingsuanState.gameOver = true;
        // 计算结果
        calculateJingsuanResult();
      }
    }, 100);
  });

  // 精算：移动牌
  socket.on('jingsuanMoveCard', ({ cardIndex, fromZone, toZone }) => {
    if (!jingsuanState || jingsuanState.gameOver) return;
    if (socket.id !== jingsuanState.currentPlayerId) return;
    
    const card = jingsuanState.cards[cardIndex];
    if (!card) return;
    
    // 从原区域移除
    if (fromZone === 'upper') {
      jingsuanState.upperCards = jingsuanState.upperCards.filter(c => c !== card);
    } else if (fromZone === 'top') {
      jingsuanState.topZone = jingsuanState.topZone.filter(c => c !== card);
    } else if (fromZone === 'bottom') {
      jingsuanState.bottomZone = jingsuanState.bottomZone.filter(c => c !== card);
    }
    
    // 添加到目标区域
    if (toZone === 'upper') {
      if (jingsuanState.upperCards.length < 9) {
        jingsuanState.upperCards.push(card);
      }
    } else if (toZone === 'top') {
      if (jingsuanState.topZone.length < 10) {
        jingsuanState.topZone.push(card);
      }
    } else if (toZone === 'bottom') {
      if (jingsuanState.bottomZone.length < 10) {
        jingsuanState.bottomZone.push(card);
      }
    }
    
    io.emit('jingsuanUpdate', {
      upperCards: jingsuanState.upperCards,
      topZone: jingsuanState.topZone,
      bottomZone: jingsuanState.bottomZone
    });
  });

  // 精算：结束游戏
  socket.on('jingsuanEndGame', () => {
    if (!jingsuanState || jingsuanState.gameOver) return;
    if (socket.id !== jingsuanState.currentPlayerId) return;
    jingsuanState.gameOver = true;
    calculateJingsuanResult();
  });

  // 精算：关闭面板
  socket.on('jingsuanClose', () => {
    // 恢复扑克牌堆为52张
    initPukepaiDeck();
    shufflePukepaiDeck();
    io.emit('jingsuanPanelClose');
  });

  // 计算精算结果的函数
  function calculateJingsuanResult() {
    if (!jingsuanState) return;
    
    const current = players.find(p => p.id === jingsuanState.currentPlayerId);
    if (!current) return;
    
    // 计算B区上半区点数和（K=13, Q=12, J=11, A=1, 其他按牌面）
    let topSum = 0;
    jingsuanState.topZone.forEach(card => {
      if (card.rank === 13) topSum += 13; // K
      else if (card.rank === 12) topSum += 12; // Q
      else if (card.rank === 11) topSum += 11; // J
      else if (card.rank === 1) topSum += 1; // A
      else topSum += card.rank;
    });
    
    // 计算B区下半区点数和
    let bottomSum = 0;
    jingsuanState.bottomZone.forEach(card => {
      if (card.rank === 13) bottomSum += 13;
      else if (card.rank === 12) bottomSum += 12;
      else if (card.rank === 11) bottomSum += 11;
      else if (card.rank === 1) bottomSum += 1;
      else bottomSum += card.rank;
    });
    
    const totalCards = jingsuanState.topZone.length + jingsuanState.bottomZone.length;
    
    // 判断结果
    if (topSum !== bottomSum || totalCards < 4) {
      // 失败：-13
      previewMoney(current.id, -13);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('jingsuanResult', {
        success: false,
        topSum,
        bottomSum,
        totalCards,
        playerId: current.id,
        playerName: current.name,
        playerColor: current.color,
        reward: -13
      });
      const failReason = totalCards < 4 ? `＜4张，${coloredName(current.name, current.color)}计算失败-13` : `${coloredName(current.name, current.color)}计算失败-13`;
      io.emit('updateAreaE', { message: failReason });
    } else {
      // 成功：根据牌数量给予奖励
      let reward = 0;
      if (totalCards === 4) reward = 0;
      else if (totalCards === 5 || totalCards === 6) reward = 5;
      else if (totalCards === 7) reward = 10;
      else if (totalCards === 8) reward = 20;
      else if (totalCards === 9) reward = 50;
      
      if (reward > 0) {
        previewMoney(current.id, reward);
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('jingsuanResult', {
        success: true,
        topSum,
        bottomSum,
        totalCards,
        playerId: current.id,
        playerName: current.name,
        playerColor: current.color,
        reward
      });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}算出${totalCards}张+${reward}` });
    }
    
    // 恢复扑克牌堆为52张
    initPukepaiDeck();
    shufflePukepaiDeck();
    
    jingsuanState = null;
  }

  socket.on('qiyuAnduchengcangSelectTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;
    
    const targetProps = board.filter(s => s.isProperty && s.owner === targetId);
    if (targetProps.length < 2) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      const finalTargetProps = board.filter(s => s.isProperty && s.owner === finalTarget.id);
      if (finalTargetProps.length < 2) {
        qiyuState = null;
        socket.emit('showEndTurn');
        return;
      }

      anduchengcangState = {
        currentPlayerId: current.id,
        targetId: finalTarget.id,
        targetName: finalTarget.name,
        targetColor: finalTarget.color,
        currentChoice: null,
        targetChoice: null,
        phase: 'selecting'
      };
      
      io.emit('qiyuAnduchengcangSelectProp', {
        currentPlayerId: current.id,
        targetId: finalTarget.id,
        targetName: finalTarget.name,
        targetColor: finalTarget.color,
        properties: finalTargetProps.map(s => ({ id: s.id, name: s.name }))
      });
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiyuAnduchengcangPropChoice', ({ propertyId }) => {
    if (!anduchengcangState) return;

    if (socket.id === anduchengcangState.currentPlayerId) {
      anduchengcangState.currentChoice = propertyId;
    } else if (socket.id === anduchengcangState.targetId) {
      anduchengcangState.targetChoice = propertyId;
    }

    io.to(socket.id).emit('qiyuAnduchengcangPropSelected');

    if (anduchengcangState.currentChoice !== null && anduchengcangState.targetChoice !== null) {
      const current = players.find(p => p.id === anduchengcangState.currentPlayerId);
      const target = players.find(p => p.id === anduchengcangState.targetId);
      const currentProp = board.find(s => s.id === anduchengcangState.currentChoice);
      const targetProp = board.find(s => s.id === anduchengcangState.targetChoice);

      if (anduchengcangState.currentChoice === anduchengcangState.targetChoice) {
        if (current.money < 7) {
          io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}金钱不足7，暗度陈仓失败` });
          io.to(anduchengcangState.currentPlayerId).emit('showEndTurn');
          anduchengcangState = null;
        } else {
          // 检查目标玩家是否有保护卡
          if (target.cards && target.cards.some(c => c.name === '保护卡')) {
            baohuQueryState = {
              propertyId: targetProp.id,
              ownerId: target.id,
              currentPlayerId: current.id,
              source: 'anduchengcang'
            };
            const targetSocket = io.sockets.sockets.get(target.id);
            if (targetSocket) {
              targetSocket.emit('baohuQuery', { propertyName: targetProp.name, currentPlayerName: current.name, currentPlayerColor: current.color });
            }
            io.emit('baohuOverlay', { targetPlayerId: target.id, targetName: target.name, targetColor: target.color });
            io.emit('updateAreaE', { message: `等待${coloredName(target.name, target.color)}决定是否使用保护卡` });
            return;
          }
          // 没有保护卡，直接获得地产
          previewMoney(current.id, -7);
          targetProp.owner = current.id;

          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}获得${coloredName(target.name, target.color)}的${targetProp.name}` });
          io.to(anduchengcangState.currentPlayerId).emit('showEndTurn');
          anduchengcangState = null;
        }
      } else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `暗度陈仓失败，${coloredName(current.name, current.color)}选择的是${currentProp.name}，${coloredName(target.name, target.color)}选择的是${targetProp.name}` });
        io.to(anduchengcangState.currentPlayerId).emit('showEndTurn');
        anduchengcangState = null;
      }
    }
  });

  socket.on('qiyuQiankundanayiConfirm', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      const tempPos = current.position;
      current.position = finalTarget.position;
      finalTarget.position = tempPos;
      
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}与${coloredName(finalTarget.name, finalTarget.color)}互换位置` });
      io.to(current.id).emit('showEndTurn');
      qiankundanayiState = null;
    }, () => {
      qiyuState = null;
      socket.emit('showEndTurn');
    }, (source) => {
      const tempPos = current.position;
      current.position = source.position;
      source.position = tempPos;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `反弹！${coloredName(current.name, current.color)}与${coloredName(source.name, source.color)}互换位置` });
      io.to(current.id).emit('showEndTurn');
      qiankundanayiState = null;
    });
  });

  socket.on('qiyuTapieConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const emptyProps = board.filter(s => s.isProperty && !s.owner && s.price < 36);
    if (emptyProps.length === 0) {
      io.emit('updateAreaE', { message: '踏破铁鞋：没有空地' });
      socket.emit('showEndTurn');
      return;
    }
    
    const randomProp = emptyProps[Math.floor(Math.random() * emptyProps.length)];
    previewMoney(current.id, -20);
    randomProp.owner = current.id;
    
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}花20获得${randomProp.name}` });
    socket.emit('showEndTurn');
  });

  socket.on('qiyuYanxueChoice', ({ choice }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    if (choice === 'hospital') {
      setPlayerState(current, 'inJail', true);
      if (current.inJail) {
        current.jailState = 'hospital';
        current.position = JAIL_HOSPITAL_ID;
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}到医院` });
    } else if (choice === 'minus8') {
      previewMoney(current.id, -8);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}-8` });
    }
    socket.emit('showEndTurn');
  });

  socket.on('sansiOtherSelect', ({ option }) => {
    if (!sansiState || sansiState.phase !== 'otherSelect') return;
    const target = players.find(p => p.id === socket.id);
    if (!target || target.id !== sansiState.targetId) return;

    if (option === '随机飞' && !target.inJail) {
      const fromPos = target.position;
      const targetPos = Math.floor(Math.random() * BOARD_SIZE);
      let steps = targetPos - fromPos;
      if (steps <= 0) steps += BOARD_SIZE;
      target.position = targetPos;
      sansiState.selectedOption = option;
      io.emit('diceResult', { playerId: target.id, fromPos, dice: steps, newPos: targetPos, teleport: true });
      diceAnimState = { playerId: target.id, fromPos, dice: steps, newPos: targetPos };
      sansiState.pendingAnim = true;
      return;
    }

    if (option === '+5，后退5步' && !target.inJail) {
      const fromPos = target.position;
      let newPos = fromPos - 5;
      if (newPos < 0) newPos += BOARD_SIZE;
      target.position = newPos;
      previewMoney(target.id, 5);
      sansiState.selectedOption = option;
      io.emit('diceResult', { playerId: target.id, fromPos, dice: 5, newPos, direction: 'backward' });
      diceAnimState = { playerId: target.id, fromPos, dice: 5, newPos };
      sansiState.pendingAnim = true;
      return;
    }

    if (option === '解冻，后退3步' && !target.inJail) {
      const fromPos = target.position;
      let newPos = fromPos - 3;
      if (newPos < 0) newPos += BOARD_SIZE;
      target.position = newPos;
      if (target.frozen > 0) { previewMoney(target.id, target.frozen); target.frozen = 0; }
      sansiState.selectedOption = option;
      io.emit('diceResult', { playerId: target.id, fromPos, dice: 3, newPos, direction: 'backward' });
      diceAnimState = { playerId: target.id, fromPos, dice: 3, newPos };
      sansiState.pendingAnim = true;
      return;
    }

    if (option === '倒退卡+1，后退7步' && !target.inJail) {
      const fromPos = target.position;
      let newPos = fromPos - 7;
      if (newPos < 0) newPos += BOARD_SIZE;
      target.position = newPos;
      const backCard = cardData.find(c => c.id === 16);
      if (backCard) {
        if (!target.cards) target.cards = [];
        addCardToPlayer(target, backCard);
      }
      sansiState.selectedOption = option;
      io.emit('diceResult', { playerId: target.id, fromPos, dice: 7, newPos, direction: 'backward' });
      diceAnimState = { playerId: target.id, fromPos, dice: 7, newPos };
      sansiState.pendingAnim = true;
      return;
    }

    if (option === '前进7步，休息1回合' && !target.inJail) {
      const fromPos = target.position;
      const newPos = (fromPos + 7) % BOARD_SIZE;
      target.position = newPos;
      applyRest(target.id, 1, `${coloredName(target.name, target.color)}前进7步，休息1回合`, null);
      sansiState.selectedOption = option;
      io.emit('diceResult', { playerId: target.id, fromPos, dice: 7, newPos });
      diceAnimState = { playerId: target.id, fromPos, dice: 7, newPos };
      sansiState.pendingAnim = true;
      return;
    }

    if (option === '每人给你3，后退5步' && !target.inJail) {
      players.forEach(p => {
        if (p.id !== target.id && !p.bankrupt) {
          p.money -= 3;
          target.money += 3;
        }
      });
      const fromPos = target.position;
      const newPos = (fromPos - 5 + BOARD_SIZE) % BOARD_SIZE;
      target.position = newPos;
      sansiState.selectedOption = option;
      io.emit('diceResult', { playerId: target.id, fromPos, dice: 5, newPos, direction: 'backward' });
      diceAnimState = { playerId: target.id, fromPos, dice: 5, newPos };
      sansiState.pendingAnim = true;
      return;
    }

    if (option === '前进1步，给地产最少的6' && !target.inJail) {
      const fromPos = target.position;
      const newPos = (fromPos + 1) % BOARD_SIZE;
      target.position = newPos;
      target.money -= 6;
      const ap = players.filter(p => !p.bankrupt);
      let minProps = Infinity;
      let candidates = [];
      for (const p of ap) {
        const propCount = board.filter(s => s.isProperty && s.owner === p.id).length;
        if (propCount < minProps) { minProps = propCount; candidates = [p]; }
        else if (propCount === minProps) candidates.push(p);
      }
      if (candidates.length > 0) {
        const recipient = candidates[Math.floor(Math.random() * candidates.length)];
        recipient.money += 6;
      }
      sansiState.selectedOption = option;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('diceResult', { playerId: target.id, fromPos, dice: 1, newPos });
      diceAnimState = { playerId: target.id, fromPos, dice: 1, newPos };
      sansiState.pendingAnim = true;
      return;
    }

    if (option === '到昆仑被仙人赐福，-12') {
      if (target.inJail) { target.inJail = false; target.jailState = null; }
      target.position = 6;
      target.money -= 12;
      if (kunlunState && kunlunState.playerId !== target.id) {
        kunlunState = { playerId: target.id, playerName: target.name, playerColor: target.color, progress: 0 };
      }
      if (!kunlunState) {
        kunlunState = { playerId: target.id, playerName: target.name, playerColor: target.color, progress: 0 };
      }
      sansiState.selectedOption = option;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiComplete', { playerId: target.id, playerName: target.name, playerColor: target.color, option });
      io.emit('kunlunArrive', { playerId: target.id, playerName: target.name, playerColor: target.color, progress: kunlunState.progress });
      sansiState = null;
      return;
    }

    if (option === '到澳门，工资-1') {
      if (target.inJail) { target.inJail = false; target.jailState = null; }
      target.position = 10;
      target.salary = Math.max(0, target.salary - 1);
      sansiState.selectedOption = option;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiComplete', { playerId: target.id, playerName: target.name, playerColor: target.color, option });
      sansiState = null;
      return;
    }

    // -38，随机获得空地（其他玩家选择）
    if (option === '-38，随机获得空地') {
      const emptyProps = board.filter(s => s.isProperty && !s.owner);
      let optionDisplay = option;
      if (emptyProps.length === 0) {
        optionDisplay = `${option}（没有合适的空地）`;
        io.emit('updateAreaE', { message: '没有合适的空地' });
      } else {
        previewMoney(target.id, -38);
        const targetProp = emptyProps[Math.floor(Math.random() * emptyProps.length)];
        targetProp.owner = target.id;
        optionDisplay = `${option}（${targetProp.name}）`;
      }
      sansiState.selectedOption = optionDisplay;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiComplete', { playerId: target.id, playerName: target.name, playerColor: target.color, option: optionDisplay, targetMsg: '' });
      sansiState = null;
      return;
    }

    // 休息2回合，随机2个他人地产停业（其他玩家选择）
    if (option === '休息2回合，随机2个他人地产停业') {
      const otherProps = board.filter(s => s.isProperty && s.owner && s.owner !== target.id && !players.find(p => p.id === s.owner)?.bankrupt);
      let optionDisplay = option;
      if (otherProps.length === 0) {
        optionDisplay = `${option}（没有合适的地产）`;
        io.emit('updateAreaE', { message: '没有合适的地产' });
      } else {
        applyRest(target.id, 2, `${coloredName(target.name, target.color)}休息2回合，随机他人地产停业`, null, null, { skipShowEndTurn: true });
        const shuffled = otherProps.sort(() => Math.random() - 0.5);
        const toClose = shuffled.slice(0, Math.min(2, shuffled.length));
        toClose.forEach(prop => { prop.closed = true; });
        optionDisplay = `${option}（${toClose.length}块地产停业）`;
      }
      sansiState.selectedOption = optionDisplay;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiComplete', { playerId: target.id, playerName: target.name, playerColor: target.color, option: optionDisplay, targetMsg: '' });
      sansiState = null;
      return;
    }

    // -10，获得随机1张卡片（其他玩家选择）
    if (option === '-10，获得随机1张卡片') {
      previewMoney(target.id, -10);
      const card = getRandomCard();
      if (card) {
        if (!target.cards) target.cards = [];
        addCardToPlayer(target, card);
      }
      const optionDisplay = `${option}${card ? `（${card.name}）` : ''}`;
      sansiState.selectedOption = optionDisplay;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiComplete', { playerId: target.id, playerName: target.name, playerColor: target.color, option: optionDisplay, targetMsg: '' });
      sansiState = null;
      return;
    }

    // -7（其他玩家选择）
    if (option === '-7') {
      previewMoney(target.id, -7);
      sansiState.selectedOption = option;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiComplete', { playerId: target.id, playerName: target.name, playerColor: target.color, option, targetMsg: '' });
      sansiState = null;
      return;
    }

    // 上家-4，下家-3（其他玩家选择）
    if (option === '上家-4，下家-3') {
      const alive = players.filter(p => !p.bankrupt);
      const ci = alive.findIndex(p => p.id === target.id);
      const prevP = alive[(ci - 1 + alive.length) % alive.length];
      const nextP = alive[(ci + 1) % alive.length];
      previewMoney(prevP.id, -4);
      previewMoney(nextP.id, -3);
      sansiState.selectedOption = option;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiComplete', { playerId: target.id, playerName: target.name, playerColor: target.color, option, targetMsg: '' });
      sansiState = null;
      return;
    }

    // 到起点（其他玩家选择）
    if (option === '到起点') {
      if (target.inJail) { target.inJail = false; target.jailState = null; }
      target.position = 0;
      sansiState.selectedOption = option;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiComplete', { playerId: target.id, playerName: target.name, playerColor: target.color, option, targetMsg: '' });
      sansiState = null;
      return;
    }

    const result = executeSansiOption(target, option, socket);

    if (result && result.type === 'noAsset') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiComplete', { playerId: target.id, playerName: target.name, playerColor: target.color, option, targetMsg: '' });
      io.emit('updateAreaE', { message: '没有钥匙' });
      sansiState = null;
      return;
    }

    if (result && result.noProperty) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiComplete', { playerId: target.id, playerName: target.name, playerColor: target.color, option, targetMsg: '' });
      io.emit('updateAreaE', { message: '没有合适的地产' });
      sansiState = null;
      return;
    }

    if (result && result.type === 'selectPropertyClosed') {
      sansiState.phase = 'selectPropertyClosed';
      sansiState.selectedOption = option;
      sansiState.freeze = result.freeze || 0;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('sansiSelectPropertyClosed', { playerId: target.id, option });
      return;
    }

    if (result && result.type === 'diamondConvert') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
      io.emit('updateAreaE', { message: '钻石回到钻石格子' });
    }

    let targetMsg = '';
    if (result && result.type === 'targetInfo') {
    }

    if (result && result.randomPropName) {
      targetMsg = '';
      option = `${option}（${result.randomPropName}）`;
    }

    if (result && result.type === 'animate' && result.targetInfo) {
      targetMsg = '';
    }

    const sender = players.find(p => p.id === sansiState.playerId);
    if (sender && sansiState.selectedOption === '和下家一起+7，工资-3') {
      executeSansiOption(sender, sansiState.selectedOption, socket, target);
    }

    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('sansiComplete', { playerId: target.id, playerName: target.name, playerColor: target.color, option, targetMsg });
    sansiState = null;
  });

  socket.on('sansiOtherSkip', () => {
    if (!sansiState || sansiState.phase !== 'otherSelect') return;
    const target = players.find(p => p.id === socket.id);
    if (!target || target.id !== sansiState.targetId) return;
    const current = players[currentPlayerIndex];
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('sansiCannotSelect', { targetName: target.name, targetColor: target.color });
    sansiState = null;
  });

  socket.on('petShopSelect', ({ option }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;

    if (option === '宠物') {
      let randomCw = null;
      if (petPool.length > 0) {
        const randomIndex = Math.floor(Math.random() * petPool.length);
        randomCw = petPool[randomIndex];
      }
      const activePlayers = players.filter(p => !p.bankrupt);
      auctionState = {
        card: null,
        petImage: randomCw,
        bids: {},
        passedPlayers: [],
        currentBidderIndex: activePlayers.findIndex(p => p.id === current.id),
        activePlayers: activePlayers.map(p => p.id),
        currentBid: 0,
        lastBidderId: null,
        isPetAuction: true
      };
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      const petInfo = getPetInfo(randomCw);
      io.emit('petAuctionStart', {
        petImage: randomCw,
        petName: petInfo ? petInfo.name : '',
        petDesc: petInfo ? petInfo.desc : '',
        currentBidderId: current.id,
        currentBidderName: current.name,
        currentBidderColor: current.color
      });
      return;
    } else if (option === '自选卡') {
      io.emit('petShopCardGrid', { playerId: current.id, cards: cardData.filter((c, i, arr) => arr.findIndex(x => x.image === c.image) === i) });
      return;
    } else if (option === '空地') {
      const emptyProps = board.filter(s => s.isProperty && !s.owner);
      if (emptyProps.length > 0) {
        io.emit('petShopEmptyProps', { playerId: current.id, properties: emptyProps.map(p => ({ id: p.id, name: p.name, price: p.price })) });
        return;
      }
    }

    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}选择了${option}` });
    socket.emit('showEndTurn');
  });

  socket.on('petShopCardChosen', ({ cardId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const card = cardData.find(c => c.id === cardId);
    if (!card) return;
    if (!current.cards) current.cards = [];
    addCardToPlayer(current, card);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}获得了${card.name}` });
    socket.emit('showEndTurn');
  });

  socket.on('petShopCardAuction', ({ cardId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const card = cardData.find(c => c.id === cardId);
    if (!card) return;
    const otherPlayers = players.filter(p => !p.bankrupt && p.id !== current.id);
    const activePlayers = [current, ...otherPlayers];
    auctionState = {
      card: card,
      bids: {},
      passedPlayers: [],
      currentBidderIndex: 0,
      activePlayers: activePlayers.map(p => p.id),
      currentBid: 0,
      roundStartBid: 0,
      lastBidderId: null,
      isPetAuction: false,
      isCardAuction: true
    };
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('auctionStart', {
      card,
      currentBidderId: current.id,
      currentBidderName: current.name,
      currentBidderColor: current.color
    });
  });

  socket.on('petShopPropertyAuction', ({ propertyId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const prop = board.find(s => s.id === propertyId && s.isProperty && !s.owner);
    if (!prop) return;
    const activePlayers = players.filter(p => !p.bankrupt);
    auctionState = {
      card: null,
      propertyId: prop.id,
      bids: {},
      passedPlayers: [],
      currentBidderIndex: activePlayers.findIndex(p => p.id === current.id),
      activePlayers: activePlayers.map(p => p.id),
      currentBid: 0,
      roundStartBid: 0,
      lastBidderId: null,
      isPetAuction: false,
      isPropertyAuction: true
    };
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('petShopEmptyPropEnd');
    io.emit('propertyAuctionStart', {
      property: { id: prop.id, name: prop.name, price: prop.price },
      currentBidderId: current.id,
      currentBidderName: current.name,
      currentBidderColor: current.color
    });
  });

  socket.on('myAssetAuction', ({ assetType, assetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    let auctionItem = null;
    let assetName = '';
    
    if (assetType === 'pet') {
      if (!current.petImage) return;
      auctionItem = { type: 'pet', petImage: current.petImage, originalPetImage: current.originalPetImage || null };
      assetName = '宠物';
    } else if (assetType === 'property') {
      const prop = board.find(s => s.id === parseInt(assetId) && s.owner === current.id);
      if (!prop) return;
      if (checkProtectedAsset(current.id, 'property')) {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的保护卡生效，${prop.name}免于拍卖` });
        return;
      }
      auctionItem = { type: 'property', propertyId: prop.id, propertyName: prop.name, propertyPrice: prop.price };
      assetName = prop.name;
    } else if (assetType === 'diamond') {
      if (!current.hasDiamond) return;
      auctionItem = { type: 'diamond' };
      assetName = '钻石';
    } else if (assetType === 'card') {
      const cardIndex = parseInt(assetId);
      if (!current.cards || !current.cards[cardIndex]) return;
      auctionItem = { type: 'card', cardIndex: cardIndex, card: current.cards[cardIndex] };
      assetName = current.cards[cardIndex].name;
    } else {
      return;
    }
    
    const otherPlayers = players.filter(p => !p.bankrupt && p.id !== current.id);
    if (otherPlayers.length === 0) return;
    const activePlayers = [current, ...otherPlayers];
    
    auctionState = {
      card: auctionItem.type === 'card' ? auctionItem.card : null,
      propertyId: auctionItem.type === 'property' ? auctionItem.propertyId : null,
      petImage: auctionItem.type === 'pet' ? auctionItem.petImage : null,
      originalPetImage: auctionItem.type === 'pet' ? auctionItem.originalPetImage : null,
      isPetAuction: auctionItem.type === 'pet',
      isPropertyAuction: auctionItem.type === 'property',
      isDiamondAuction: auctionItem.type === 'diamond',
      isCardAuction: auctionItem.type === 'card',
      cardIndex: auctionItem.type === 'card' ? auctionItem.cardIndex : null,
      sellerId: current.id,
      sellerName: current.name,
      sellerColor: current.color,
      assetName: assetName,
      bids: {},
      passedPlayers: [],
      currentBidderIndex: 0,
      activePlayers: activePlayers.map(p => p.id),
      currentBid: 0,
      roundStartBid: 0,
      lastBidderId: null
    };
    
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('myAssetAuctionStart', {
      assetType,
      assetName,
      auctionItem,
      sellerId: current.id,
      sellerName: current.name,
      sellerColor: current.color,
      currentBidderId: current.id,
      currentBidderName: current.name,
      currentBidderColor: current.color,
      startBid: 0
    });
  });

  socket.on('hiddenCardChoice', ({ hiddenType }) => {
    if (!pendingCardConfirm || pendingCardConfirm.playerId !== socket.id || !pendingCardConfirm.cardsInfo) return;
    const confirm = pendingCardConfirm;
    pendingCardConfirm = null;
    io.emit('hiddenCardOverlayClose');

    const player = players.find(p => p.id === confirm.playerId);
    if (!player) return;

    // 锦鲤/多功能卡组合流程
    if (confirm.onUsedKoi || confirm.onUsedDuogongneng) {
      if (!hiddenType) {
        if (confirm.onSkip) confirm.onSkip();
        return;
      }
      if (hiddenType.startsWith('koi_')) {
        if (confirm.onUsedKoi) confirm.onUsedKoi();
      } else if (hiddenType.startsWith('duogongneng_')) {
        if (confirm.onUsedDuogongneng) confirm.onUsedDuogongneng();
      }
      return;
    }

    if (!hiddenType) {
      pendingHiddenResult = { type: 'skip', targetId: confirm.playerId, sourceId: confirm.sourceId };
      if (confirm._callback) confirm._callback(false);
      return;
    }

    const chosenCard = confirm.cardsInfo.find(c => c.hiddenType === hiddenType);
    if (!chosenCard) return;

    const idx = player.cards.findIndex(c => c.hiddenType === hiddenType);
    if (idx !== -1) player.cards.splice(idx, 1);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });

    if (hiddenType === 'quxiao') {
      const msg = `${coloredName(player.name, player.color)}使用隐藏卡取消了目标`;
      io.emit('updateAreaE', { message: msg });
      if (confirm._callback) confirm._callback(true);
      return;
    } else if (hiddenType === 'jianyuan') {
      const source = players.find(p => p.id === confirm.sourceId);
      if (source) {
        previewMoney(source.id, -9);
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      const msg = `${coloredName(player.name, player.color)}使用隐藏卡令${coloredName(source?.name, source?.color)}-9`;
      io.emit('popupMessage', { message: `<img src="/drawable/kapian/yincang.png" style="width:80px;height:auto;object-fit:contain;"><div style="color:#fff;">${msg}</div>` });
      pendingHiddenResult = { type: 'jianyuan', targetId: confirm.playerId, sourceId: confirm.sourceId, message: '' };
      if (confirm._callback) confirm._callback(false);
      return;
    } else if (hiddenType === 'zhuanyi') {
      const others = players.filter(p => p.id !== confirm.playerId && p.id !== confirm.sourceId && !p.bankrupt && !p.sheltered);
      if (others.length > 0) {
        const msg = `${coloredName(player.name, player.color)}使用隐藏卡将目标转移`;
        io.emit('showTip', { imgSrc: '/drawable/kapian/yincang.png', text: msg });
        const targetSocket = io.sockets.sockets.get(confirm.playerId);
        if (targetSocket) {
          targetSocket.emit('selectHiddenTransferTarget', { 
            players: others.map(p => ({ id: p.id, name: p.name, color: p.color })),
            sourceName: confirm.sourceName
          });
        }
        pendingHiddenResult = { type: 'zhuanyi', targetId: confirm.playerId, sourceId: confirm.sourceId, _callback: confirm._callback, message: '' };
        return;
      } else {
        const msg = `${coloredName(player.name, player.color)}使用隐藏卡，导致没有合适的目标`;
          io.emit('updateAreaE', { message: msg });
          io.emit('closeAllPanels');
          if (confirm._callback) confirm._callback(true);
          return;
      }
    } else if (hiddenType === 'fantan') {
      const msg = `${coloredName(player.name, player.color)}使用隐藏卡将效果反弹`;
        io.emit('popupMessage', { message: `<img src="/drawable/kapian/yincang.png" style="width:80px;height:auto;object-fit:contain;"><div style="color:#fff;">${msg}</div>` });
        pendingHiddenResult = { type: 'fantan', targetId: confirm.playerId, sourceId: confirm.sourceId, message: '' };
        if (confirm._callback) confirm._callback(false);
      return;
    }
  });

  socket.on('cardConfirmResponse', ({ use }) => {
    if (!pendingCardConfirm || pendingCardConfirm.playerId !== socket.id) return;
    const confirm = pendingCardConfirm;
    pendingCardConfirm = null;
    // 广播关闭卡片确认覆盖
    io.emit('cardConfirmOverlayClose');

    const player = players.find(p => p.id === confirm.playerId);
    if (!player) return;
    
    if (confirm.cardName === '免休卡') {
      if (use) {
        const idx = player.cards.findIndex(c => c.name === '免休卡');
        if (idx !== -1) player.cards.splice(idx, 1);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(player.name, player.color)}使用了免休卡` });
        if (confirm.onUsed) confirm.onUsed();
      } else {
        if (confirm.reason === '进监狱区域') {
          // 街头斗殴等场景：调用onNotUsed回调，不执行固定逻辑
          if (confirm.onNotUsed) {
            confirm.onNotUsed();
          } else {
            // 默认逻辑：资本主义罪等场景
            if (returnDiamondIfHeld(player)) {
              io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
            }
            const msg = `${coloredName(player.name, player.color)}巨额财产来源不明罪，进医院`;
            io.emit('updateAreaE', { message: msg });
            setPlayerState(player, 'inJail', true);
            if (player.inJail) {
              player.jailState = 'jail';
              player.position = JAIL_JAIL_ID;
              io.emit('showJailMap', { players, board, currentPlayerIndex, message: msg, currentDiceValue });
            }
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          }
        } else if (confirm.reason === '进海南') {
          setPlayerState(player, 'inJail', true);
          if (player.inJail) {
            player.position = JAIL_ISLAND_ID;
            player.jailState = 'island';
            player.jailTurns = 0;
          }
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          // 免休卡不使用，执行进海南效果，但如果有onNotUsed回调（如流放卡使用者），也要执行
          if (confirm.onNotUsed) confirm.onNotUsed();
        } else if (confirm.reason === '进医院') {
          setPlayerState(player, 'inJail', true);
          if (player.inJail) {
            if (returnDiamondIfHeld(player)) {
              io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 });
            }
            player.position = JAIL_HOSPITAL_ID;
            player.jailState = 'hospital';
          }
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          // 免休卡不使用，执行进医院效果，但如果有onNotUsed回调，也要执行
          if (confirm.onNotUsed) confirm.onNotUsed();
        } else if (confirm.reason === '休息') {
          // 休息场景现在通过applyRest的回调处理，不执行固定逻辑
          if (confirm.onNotUsed) {
            confirm.onNotUsed();
          } else {
            player.restTurns += confirm.restAmount || 1;
            if (confirm.restMessage && confirm.restMessage.includes('避难所')) {
              if (!player.shelteredTurns) setPlayerState(player, 'shelteredTurns', 2);
            }
            if (confirm.shelterTurns) {
              setPlayerState(player, 'shelteredTurns', confirm.shelterTurns);
            }
            updateShelteredState();
            io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          }
          // 免休卡不使用：不改E区内容，不发送结束按钮（无论skipShowEndTurn是什么）
        } else if (confirm.onNotUsed) {
          confirm.onNotUsed();
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        }
      }
    } else if (confirm.cardName === '免路费卡') {
      if (use) {
        if (confirm.onUsed) confirm.onUsed();
      } else {
        if (confirm.onNotUsed) confirm.onNotUsed();
      }
    } else if (confirm.cardName === '钥匙') {
      if (use) {
        const idx = player.cards.findIndex(c => c.id === 13);
        if (idx !== -1) player.cards.splice(idx, 1);
        io.emit('updateAreaE', { message: `${coloredName(player.name, player.color)}使用钥匙，${confirm.reward}` });
        if (confirm.onUsed) {
          confirm.onUsed();
        }
      } else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        socket.emit('showEndTurn');
      }
    } else if (confirm.cardName === '多功能卡') {
      if (use) {
        const idx = player.cards.findIndex(c => c.name === '多功能卡');
        if (idx !== -1) player.cards.splice(idx, 1);
        if (confirm.hiddenType === 'duogongneng_rent') {
          io.emit('updateAreaE', { message: `${coloredName(player.name, player.color)}使用多功能卡令路费-10` });
          if (confirm.onUsed) {
            confirm.onUsed();
          }
        } else if (confirm.hiddenType === 'duogongneng_judge') {
          if (confirm.onUsed) {
            confirm.onUsed();
          }
        } else if (confirm.hiddenType === 'duogongneng_chance') {
          if (confirm.onUsed) {
            confirm.onUsed();
          }
        }
      } else {
        if (confirm.hiddenType === 'duogongneng_rent' && confirm.onUsed) {
          confirm.onUsed();
        } else if (confirm.hiddenType === 'duogongneng_judge') {
          if (confirm.originalResult) {
            confirm.originalResult();
          }
        } else if (confirm.hiddenType === 'duogongneng_chance') {
          if (confirm.originalResult) {
            confirm.originalResult();
          }
        }
      }
    } else if (confirm.cardName === '隐藏卡·抵消' && confirm._dixiaoPending) {
      if (use) {
        const idx = player.cards.findIndex(c => c.hiddenType === 'dixiao');
        if (idx !== -1) player.cards.splice(idx, 1);
        const originalPlayer = players.find(p => p.id === confirm.originalPlayerId);
        if (originalPlayer && confirm.originalCardIndex < originalPlayer.cards.length) {
          originalPlayer.cards.splice(confirm.originalCardIndex, 1);
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(player.name, player.color)}使用了隐藏卡抵消了${coloredName(originalPlayer?.name, originalPlayer?.color)}的${confirm.originalCardName}卡片效果` });
        const originalSocket = io.sockets.sockets.get(confirm.originalPlayerId);
      } else {
        const originalPlayer = players.find(p => p.id === confirm.originalPlayerId);
        const originalSocket = io.sockets.sockets.get(confirm.originalPlayerId);
        if (originalPlayer && originalSocket) {
          executeUseCard(originalSocket, originalPlayer, confirm.originalCardName, confirm.originalCardIndex);
        }
      }
    } else if (confirm._targetCallback) {
      if (use) {
        const idx = player.cards.findIndex(c => c.hiddenType === confirm.hiddenType);
        if (idx !== -1) player.cards.splice(idx, 1);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });

        if (confirm.hiddenType === 'quxiao') {
          const msg = `${coloredName(player.name, player.color)}使用隐藏卡取消了目标`;
          io.emit('updateAreaE', { message: msg });
          if (confirm._callback) confirm._callback(true);
          return;
        } else if (confirm.hiddenType === 'jianyuan') {
          const source = players.find(p => p.id === confirm.sourceId);
          if (source) {
            previewMoney(source.id, -9);
          }
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          const msg = `${coloredName(player.name, player.color)}使用隐藏卡令${coloredName(source?.name, source?.color)}-9`;
          io.emit('popupMessage', { message: `<img src="/drawable/kapian/yincang.png" style="width:80px;height:auto;object-fit:contain;"><div style="color:#fff;">${msg}</div>` });
          pendingHiddenResult = { type: 'jianyuan', targetId: confirm.playerId, sourceId: confirm.sourceId, message: msg };
          if (confirm._callback) confirm._callback(false);
          return;
        } else if (confirm.hiddenType === 'zhuanyi') {
          const others = players.filter(p => p.id !== confirm.playerId && p.id !== confirm.sourceId && !p.bankrupt && !p.sheltered);
          if (others.length > 0) {
            const msg = `${coloredName(player.name, player.color)}使用隐藏卡将目标转移`;
            io.emit('updateAreaE', { message: msg });
            const targetSocket = io.sockets.sockets.get(confirm.playerId);
            if (targetSocket) {
              targetSocket.emit('selectHiddenTransferTarget', { 
                players: others.map(p => ({ id: p.id, name: p.name, color: p.color })),
                sourceName: confirm.sourceName
              });
            }
            pendingHiddenResult = { type: 'zhuanyi', targetId: confirm.playerId, sourceId: confirm.sourceId, _callback: confirm._callback, message: msg };
            return;
          } else {
            const msg = `${coloredName(player.name, player.color)}使用隐藏卡，导致没有合适的目标`;
              io.emit('updateAreaE', { message: msg });
              io.emit('closeAllPanels');
              if (confirm._callback) confirm._callback(true);
              return;
          }
        } else if (confirm.hiddenType === 'fantan') {
          const msg = `${coloredName(player.name, player.color)}使用隐藏卡将效果反弹`;
            io.emit('popupMessage', { message: `<img src="/drawable/kapian/yincang.png" style="width:80px;height:auto;object-fit:contain;"><div style="color:#fff;">${msg}</div>` });
            pendingHiddenResult = { type: 'fantan', targetId: confirm.playerId, sourceId: confirm.sourceId, message: '' };
            if (confirm._callback) confirm._callback(false);
          return;
        }
      } else {
        pendingHiddenResult = { type: 'skip', targetId: confirm.playerId, sourceId: confirm.sourceId };
        if (confirm._callback) confirm._callback(false);
      }
    }
  });

  socket.on('hiddenTransferTarget', (targetId) => {
    if (!pendingHiddenResult || pendingHiddenResult.type !== 'zhuanyi') return;
    const newTarget = players.find(p => p.id === targetId);
    if (!newTarget) return;
    const source = players.find(p => p.id === pendingHiddenResult.sourceId);
    const oldTarget = players.find(p => p.id === pendingHiddenResult.targetId);
    io.emit('showTip', { imgSrc: '/drawable/kapian/yincang.png', text: `${oldTarget?.name || '未知'}使用隐藏卡将目标转移给${newTarget.name}` });
    pendingHiddenResult.newTargetId = targetId;
    const callback = pendingHiddenResult._callback;
    if (callback) callback(false);
  });

  socket.on('useCard', ({ cardName, cardIndex: clientCardIndex }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!current.cards) return;
    const cardIndex = clientCardIndex !== undefined ? clientCardIndex : current.cards.findIndex(c => c.name === cardName);
    if (cardIndex === -1 || cardIndex >= current.cards.length) return;
    if (current.cards[cardIndex].name !== cardName) return;

    const dixiaoPlayer = players.find(p => p.id !== current.id && !p.bankrupt && p.cards && p.cards.some(c => c.hiddenType === 'dixiao'));
    if (dixiaoPlayer) {
      const dixiaoIdx = dixiaoPlayer.cards.findIndex(c => c.hiddenType === 'dixiao');
      pendingCardConfirm = {
        playerId: dixiaoPlayer.id,
        cardName: '隐藏卡·抵消',
        cardIndex: dixiaoIdx,
        reason: 'dixiao',
        originalCardName: cardName,
        originalPlayerId: current.id,
        originalCardIndex: cardIndex,
        _dixiaoPending: true
      };
      const dixiaoSocket = io.sockets.sockets.get(dixiaoPlayer.id);
      if (dixiaoSocket) {
        dixiaoSocket.emit('cardConfirmPopup', { cardName: '隐藏卡·抵消', image: 'yincang', description: `${coloredName(current.name, current.color)}准备使用${cardName}，是否使用隐藏卡令其无效？`, reason: 'dixiao' });
      }
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}准备使用${cardName}，是否使用隐藏卡？` });
      return;
    }

    executeUseCard(socket, current, cardName, cardIndex);
  });

  function doZheRenFengPay(payer, owner, space, skt) {
    const spaceName = space.name;
    previewMoney(payer.id, -4);
    previewMoney(owner.id, 4);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `蜇人蜂给${coloredName(owner.name, owner.color)}4选择了${spaceName}作为目标` });
    zheRenFengState = { payerId: payer.id, ownerId: owner.id, spaceId: space.id, spaceName };
    const ownerSocket = io.sockets.sockets.get(owner.id);
    if (ownerSocket) {
      ownerSocket.emit('zheRenFengOwnerChoice', { spaceName, ownerName: owner.name, ownerColor: owner.color });
    }
  }

  socket.on('baohuConfirm', ({ useProtect }) => {
    if (!baohuQueryState) return;
    if (socket.id !== baohuQueryState.ownerId) return;

    // 清除所有人的bottomBar覆盖
    io.emit('clearBottomBarOverlay');

    const owner = players.find(p => p.id === baohuQueryState.ownerId);
    const current = players.find(p => p.id === baohuQueryState.currentPlayerId);
    const prop = board.find(s => s.id === baohuQueryState.propertyId);
    if (!owner || !current || !prop) {
      baohuQueryState = null;
      return;
    }

    if (useProtect) {
      // 移除保护卡
      const cardIndex = owner.cards.findIndex(c => c.name === '保护卡');
      if (cardIndex === -1) {
        baohuQueryState = null;
        return;
      }
      owner.cards.splice(cardIndex, 1);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(owner.name, owner.color)}使用了保护卡保护了${prop.name}` });
      // 清除对应的状态
      const source = baohuQueryState.source;
      if (source === 'dacaoRentBonus') {
        // 打草惊蛇路费-3被保护卡阻止
        dacaoState = null;
      } else if (source === 'anduchengcang') {
        anduchengcangState = null;
      } else if (source === 'gongcheng') {
        gongchengState = null;
      } else if (source === 'zheRenFeng') {
        zheRenFengState = null;
      }
      // 当前玩家F更新为结束
      const currentSocket = io.sockets.sockets.get(current.id);
      if (currentSocket) currentSocket.emit('showEndTurn');
      io.emit('clearRobHighlight');
    } else {
      // 不使用保护卡，继续执行原来的逻辑
      const source = baohuQueryState.source;
      if (source === 'qiyu') {
        const qiyuName = baohuQueryState.qiyuName;
        let message = '';
        if (qiyuName === '查封') {
          prop.closed = true;
          message = `${prop.name}停业`;
        } else if (qiyuName === '造谣') {
          prop.rentBonus = (prop.rentBonus || 0) - 1;
          message = `${prop.name}路费-1`;
        } else if (qiyuName === '繁荣') {
          prop.rentBonus = (prop.rentBonus || 0) + 1;
          message = `${prop.name}路费+1`;
        }
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuComplete', { playerId: current.id, message });
        const currentSocket = io.sockets.sockets.get(current.id);
        if (currentSocket) currentSocket.emit('showEndTurn');
      } else if (source === 'gaitu') {
        const rent = baohuQueryState.rent || 0;
        previewMoney(owner.id, -rent);
        previewMoney(current.id, rent);
        prop.closed = true;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}抢劫${coloredName(owner.name, owner.color)}路费${rent}，${prop.name}停业` });
        io.emit('clearRobHighlight');
        const currentSocket = io.sockets.sockets.get(current.id);
        if (currentSocket) currentSocket.emit('showEndTurn');
      } else if (source === 'dacaoRentBonus') {
        // 打草惊蛇不使用保护卡，执行路费-3
        const gaveNames = [];
        for (const [playerId, gave] of Object.entries(dacaoState.responses)) {
          if (gave) {
            const p = players.find(pl => pl.id === playerId);
            if (p) gaveNames.push(coloredName(p.name, p.color));
          }
        }
        const targetGave = dacaoState.responses[dacaoState.targetOwnerId];
        finishDacaoComplete(gaveNames, targetGave, owner, prop, current);
      } else if (source === 'anduchengcang') {
        // 暗度陈仓不使用保护卡，继续执行获得地产
        if (current.money < 7) {
          io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}金钱不足7，暗度陈仓失败` });
        } else {
          previewMoney(current.id, -7);
          prop.owner = current.id;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}获得${coloredName(owner.name, owner.color)}的${prop.name}` });
        }
        anduchengcangState = null;
        const currentSocket = io.sockets.sockets.get(current.id);
        if (currentSocket) currentSocket.emit('showEndTurn');
      } else if (source === 'gongcheng') {
        // 攻城不使用保护卡，继续执行
        gongchengState.targetId = owner.id;
        io.emit('gongchengShowPanel', {
          targetId: owner.id,
          propId: prop.id,
          propName: prop.name,
          attackerName: current.name,
          attackerColor: current.color
        });
      } else if (source === 'zheRenFeng') {
        // 蜇人蜂不使用保护卡，继续执行
        doZheRenFengPay(current, owner, prop, socket);
      }
    }
    baohuQueryState = null;
  });

  function executeUseCard(socket, current, cardName, cardIndex) {
    const card = current.cards[cardIndex];
    if (cardName === '骰子1' || cardName === '骰子2' || cardName === '骰子3') {
      const diceVal = parseInt(cardName.replace('骰子', ''));
      current.cards.splice(cardIndex, 1);
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用了骰子${diceVal}` });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      socket.emit('autoRollDice', diceVal);
    } else if (card && card.isColorDice) {
      current.cards.splice(cardIndex, 1);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      if (card.diceType === 'chooseOne') {
        const dice1 = Math.floor(Math.random() * 6) + 1;
        let dice2 = Math.floor(Math.random() * 6) + 1;
        while (dice2 === dice1) {
          dice2 = Math.floor(Math.random() * 6) + 1;
        }
        io.emit('clearAreaG', { playerId: current.id });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用彩色骰子，二选一作为落点` });
        socket.emit('colorDiceChooseOne', { dice1, dice2 });
      } else if (card.diceType === 'sum') {
        const dice1 = Math.floor(Math.random() * 6) + 1;
        const dice2 = Math.floor(Math.random() * 6) + 1;
        const sum = dice1 + dice2;
        currentDiceValue = sum;
        io.emit('clearAreaG', { playerId: current.id });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用彩色骰子` });
        io.emit('colorDiceSumDisplay', { playerId: current.id, dice1, dice2, sum });
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        socket.emit('colorDiceResult', { dice1, dice2, sum });
      } else if (card.diceType === 'moneyPlus') {
        const rawDice = Math.floor(Math.random() * 6) + 1;
        const moveSteps = rawDice + 2;
        previewMoney(current.id, moveSteps);
        current.cards.splice(cardIndex, 1);
        currentDiceValue = rawDice;
        io.emit('clearAreaG', { playerId: current.id });
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('colorDiceMoneyPlus', { playerId: current.id, playerName: current.name, playerColor: current.color, rawDice, moveSteps });
        // 通过rollDice移动，设unrestrictedDice标记跳过范围限制
        unrestrictedDice = moveSteps;
        socket.emit('colorDiceResult', { rawDice, moveSteps });
      } else if (card.diceType === 'extraTurn') {
        current.extraTurns = (current.extraTurns || 0) + 1;
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用彩色骰子，获得再动一次` });
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        socket.emit('keepGArea');
      } else if (card.diceType === 'choose') {
        io.emit('clearAreaG', { playerId: current.id });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用彩色骰子，自选点数` });
        socket.emit('colorDiceSelfChoose');
      }
    } else if (cardName === '抢劫卡') {
      const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
      if (validTargets.length === 0) {
        io.emit('updateAreaE', { message: '没有合适的目标' });
      } else {
        current.cards.splice(cardIndex, 1);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}正在使用抢劫卡，请选择目标` });
        socket.emit('qiangjieSelectTarget');
      }
    } else if (cardName === '乌龟卡') {
      current.cards.splice(cardIndex, 1);
      players.forEach(p => {
        if (!p.bankrupt && p.id !== current.id) {
          if (!p.diceEffects) p.diceEffects = [];
          p.diceEffects.push({ min: 1, max: 1, tooltip: '下回合掷1' });
        }
      });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用乌龟卡，令所有他人下回合掷1` });
    } else if (cardName === '炸弹卡') {
      current.cards.splice(cardIndex, 1);
      const bombPos = (current.position - 6 + board.length) % board.length;
      zhadanState = {
        position: bombPos,
        turnsLeft: 2,
        ownerId: current.id
      };
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, zhadanState });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}设置了炸弹，2回合后爆炸，小心！` });
    } else if (cardName === '传送卡') {
      const validTargets = players.filter(p => !p.bankrupt);
      if (validTargets.length === 0) {
        io.emit('updateAreaE', { message: '没有合适的目标' });
      } else {
        current.cards.splice(cardIndex, 1);
        chuansongState = { userId: current.id, phase: 'selectTarget' };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用传送卡，请选择目标` });
        socket.emit('chuansongSelectTarget', { canSelectSelf: true });
      }
    } else if (cardName === '封地卡') {
      const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
      if (validTargets.length === 0) {
        io.emit('updateAreaE', { message: '没有合适的目标' });
      } else {
        current.cards.splice(cardIndex, 1);
        fengdiCardState = { userId: current.id, phase: 'selectTarget' };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用封地卡，请选择目标` });
        socket.emit('fengdiCardSelectTarget', { canSelectSelf: false });
      }
    } else if (cardName === '倒退卡') {
      current.cards.splice(cardIndex, 1);
      players.forEach(p => {
        if (!p.bankrupt) {
          p.daotui = true;
        }
      });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用倒退卡，令所有人倒退1回合` });
    } else if (cardName === '免路费卡') {
      const rowIds = getRowIdsForSpace(current.position);
      const affected = rowIds.map(id => board.find(sp => sp.id === id)).filter(s => s && s.isProperty && s.owner);
      if (affected.length === 0) {
        io.emit('updateAreaE', { message: '当前一排没有合适的地产' });
        return;
      }
      current.cards.splice(cardIndex, 1);
      affected.forEach(s => { s.closed = true; });
      const names = affected.map(s => s.name).join('，');
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用免路费卡令${names}停业` });
    } else if (cardName === '建房卡') {
      const rowIds = getRowIdsForSpace(current.position);
      const affected = rowIds.map(id => board.find(sp => sp.id === id)).filter(s => s && s.isProperty && s.owner);
      if (affected.length === 0) {
        io.emit('updateAreaE', { message: '当前一排没有合适的地产' });
        return;
      }
      current.cards.splice(cardIndex, 1);
      affected.forEach(s => { s.rentBonus = (s.rentBonus || 0) + 2; });
      const names = affected.map(s => s.name).join('，');
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用建房卡令${names}路费+2` });
    } else if (cardName === '龙卷风卡') {
      const validTargets = players.filter(p => !p.bankrupt);
      if (validTargets.length === 0) {
        io.emit('updateAreaE', { message: '没有合适的目标' });
      } else {
        current.cards.splice(cardIndex, 1);
        longjuanfengState = {
          userId: current.id,
          phase: 'selectTarget'
        };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用龙卷风卡，请选择目标` });
        socket.emit('longjuanfengSelectTarget', { canSelectSelf: true });
      }
    } else if (cardName === '睡眠卡') {
      const validTargets = players.filter(p => !p.bankrupt);
      if (validTargets.length === 0) {
        io.emit('updateAreaE', { message: '没有合适的目标' });
      } else {
        current.cards.splice(cardIndex, 1);
        shuimianState = { userId: current.id, phase: 'selectTarget' };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用睡眠卡，请选择目标` });
        socket.emit('shuimianSelectTarget', { canSelectSelf: true });
      }
    } else if (cardName === '陷害卡') {
      const validTargets = players.filter(p => !p.bankrupt);
      if (validTargets.length === 0) {
        io.emit('updateAreaE', { message: '没有合适的目标' });
      } else {
        current.cards.splice(cardIndex, 1);
        xianhaiState = { userId: current.id, phase: 'selectTarget' };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用陷害卡，请选择目标` });
        socket.emit('xianhaiSelectTarget', { canSelectSelf: true });
      }
    } else if (cardName === '停业卡') {
      const validTargets = players.filter(p => !p.bankrupt && board.some(s => s.isProperty && s.owner === p.id));
      if (validTargets.length === 0) {
        io.emit('updateAreaE', { message: '没有合适的目标' });
      } else {
        current.cards.splice(cardIndex, 1);
        tingyeState = { userId: current.id, phase: 'selectTarget' };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用停业卡，请选择目标` });
        socket.emit('tingyeSelectTarget', { canSelectSelf: false });
      }
    } else if (cardName === '古董卡') {
      const gudongCard = current.cards[cardIndex];
      if (!gudongCard || gudongCard.name !== '古董卡') return;
      const price = gudongCard.price || 1;
      current.cards.splice(cardIndex, 1);
      previewMoney(current.id, price);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}卖出古董卡+${price}` });
    } else if (cardName === '冰冻卡') {
      const validTargets = players.filter(p => !p.bankrupt && (!p.sheltered || p.id === current.id));
      if (validTargets.length === 0) {
        io.emit('updateAreaE', { message: '没有合适的目标' });
      } else {
        current.cards.splice(cardIndex, 1);
        bingdongState = {
          userId: current.id,
          phase: 'selectTarget'
        };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用冰冻卡，请选择目标` });
        socket.emit('bingdongSelectTarget', { canSelectSelf: true });
      }
    } else if (cardName === '闪现卡') {
      current.cards.splice(cardIndex, 1);
      shanxianSelecting = true;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用闪现卡，请选择位移位置` });
      socket.emit('shanxianSelectBoard');
    } else if (cardName === '强拆卡') {
      const curSpace = board[current.position];
      if (!curSpace || !curSpace.isProperty || !curSpace.owner || curSpace.owner === current.id) {
        io.emit('updateAreaE', { message: '当前不是他人的地产' });
        return;
      }
      if (!curSpace.houseLevel || curSpace.houseLevel < 1) {
        io.emit('updateAreaE', { message: '当前地产没有房屋' });
        return;
      }
      current.cards.splice(cardIndex, 1);
      curSpace.houseLevel--;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用强拆卡令${curSpace.name}降级` });
    } else if (cardName === '征地卡') {
      const curSpace = board[current.position];
      if (!curSpace || !curSpace.isProperty || !curSpace.owner || curSpace.owner === current.id) {
        io.emit('updateAreaE', { message: '当前不是他人的地产' });
        return;
      }
      const owner = players.find(p => p.id === curSpace.owner);
      if (!owner) return;
      if (checkProtectedAsset(owner.id, 'property')) {
        current.cards.splice(cardIndex, 1);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(owner.name, owner.color)}的保护卡生效，${curSpace.name}免于被征收` });
        return;
      }
      const houseValue = Math.floor(curSpace.price / 3);
      const totalValue = curSpace.price + (curSpace.houseLevel || 0) * houseValue;
      current.cards.splice(cardIndex, 1);
      previewMoney(current.id, -totalValue);
      previewMoney(owner.id, totalValue);
      curSpace.owner = current.id;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}给${coloredName(owner.name, owner.color)}$${totalValue}，获得了${curSpace.name}` });
    } else if (cardName === '黑客卡') {
      const validTargets = players.filter(p => !p.bankrupt && p.id !== current.id && p.frozen > 0);
      if (validTargets.length === 0) {
        io.emit('updateAreaE', { message: '没有合适的目标' });
        return;
      }
      current.cards.splice(cardIndex, 1);
      heikeState = {
        userId: current.id,
        phase: 'selectTarget'
      };
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用黑客卡，请选择目标` });
      socket.emit('heikeShowSelectTarget');
    } else if (cardName === '路障卡') {
      current.cards.splice(cardIndex, 1);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters });
      socket.emit('luzhangSelectPosition', { currentPosition: current.position });
    } else if (cardName === '净化卡') {
      // 所有人可选，包括避难状态和自己
      const validTargets = players.filter(p => !p.bankrupt);
      if (validTargets.length === 0) {
        io.emit('updateAreaE', { message: '没有合适的目标' });
        return;
      }
      // 不在这里移除净化卡，等目标选择后在effectFn中移除（因为需要触发目标的隐藏卡）
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用净化卡，请选择目标` });
      socket.emit('jinghuaSelectTarget');
    }
  }

  socket.on('jinghuaTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;


    // 使用withHiddenCheck包装，触发目标的隐藏卡（参数顺序：sourceId=使用者，targetId=目标）
    withHiddenCheck(socket.id, targetId, (finalTarget, hiddenMsg) => {

      // 在effectFn内部重新查找净化卡索引
      const idx = current.cards.findIndex(c => c.name === '净化卡');
      if (idx === -1) {
        return;
      }

      current.cards.splice(idx, 1);
      if (!finalTarget) {
        return;
      }

      // 清除所有状态（M3状态）
      finalTarget.extraTurns = 0;
      finalTarget.fuwufeiExtraMove = false;
      finalTarget.restTurns = 0; // M3状态清空
      finalTarget.sheltered = false;
      finalTarget.shelteredTurns = 0;
      finalTarget.shihua = false;
      finalTarget.guhuoDice = null;
      finalTarget.shoumaiDice = null;
      finalTarget.yinyueDice = null;
      finalTarget.shijieWar = false;
      finalTarget.hezongState = null;
      finalTarget.diceEffects = [];
      finalTarget.daotui = false;
      finalTarget.bingdong = 0;
      finalTarget.bomingFrozen = false;
      finalTarget.jinzu = false;
      finalTarget.tuolei = null;
      finalTarget.wenjigifwu = false;
      finalTarget.dizhuTurns = 0;
      finalTarget.fengdiTurns = 0;
      finalTarget.fengkongDice = null;
      finalTarget.syncedDice = null;
      finalTarget.cunqianList = [];
      finalTarget.tempMoney = 0;
      finalTarget.tempTurns = 0;
      finalTarget.protectedAsset = null;
      finalTarget.protectedAssetName = null;
      delete finalTarget.wolfMark;
      finalTarget.snakeReduction = 0;
      delete finalTarget.mammothFrozenBy;
      delete finalTarget.mammothSelfFrozen;
      if (finalTarget.inJail) { finalTarget.inJail = false; finalTarget.jailState = null; finalTarget.position = 1; }


      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用净化卡清除了${coloredName(finalTarget.name, finalTarget.color)}的状态` });
      // 不影响使用者F区和G区
    });
  });

  socket.on('heikeTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!heikeState || heikeState.userId !== current.id || heikeState.phase !== 'selectTarget') return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id || target.frozen <= 0) return;

    const doHeike = (effTarget, hiddenMsg) => {
      if (!effTarget) {
        heikeState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        return;
      }
      heikeState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}正在使用黑客卡，与${coloredName(effTarget.name, effTarget.color)}拼钱` });
      pinqianState = {
        currentPlayerId: current.id,
        targetPlayerId: effTarget.id,
        currentPlayerName: current.name,
        targetPlayerName: effTarget.name,
        currentNumber: 0,
        targetNumber: 0,
        currentConfirmed: false,
        targetConfirmed: false,
        resultType: 'heike',
        heikeFrozenAmount: effTarget.frozen
      };
      const targetSocket = io.sockets.sockets.get(effTarget.id);
      if (targetSocket) {
        targetSocket.emit('pinqianStart', {
          playerName: current.name,
          playerColor: current.color,
          targetName: effTarget.name,
          targetColor: effTarget.color,
          isCurrent: false
        });
      }
      socket.emit('pinqianStart', {
        playerName: current.name,
        playerColor: current.color,
        targetName: effTarget.name,
        targetColor: effTarget.color,
        isCurrent: true
      });
    };

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      doHeike(finalTarget, hiddenMsg);
    }, () => {
      heikeState = null;
      pendingHiddenResult = null;
    }, (source) => {
      doHeike(source, '反弹！');
    });
  });

  socket.on('luzhangSelect', ({ position }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (position < 0 || position >= board.length) return;
    if (!luzhangPositions.includes(position)) {
      luzhangPositions.push(position);
      io.emit('luzhangPlaced', { position, playerName: current.name, playerColor: current.color });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}在${board[position].name}设置路障` });
    }
  });

  socket.on('chuansongTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!chuansongState || chuansongState.userId !== current.id || chuansongState.phase !== 'selectTarget') return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;

    const doChuansong = (effTarget, hiddenMsg) => {
      if (!effTarget) {
        chuansongState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        return;
      }
      chuansongState.targetId = effTarget.id;
      chuansongState.phase = 'selectSpace';
      chuansongSelecting = true;
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}使用传送卡，请选择目标位置` });
      socket.emit('chuansongSelectBoard');
    };

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      doChuansong(finalTarget, hiddenMsg);
    }, () => {
      chuansongState = null;
      pendingHiddenResult = null;
    }, (source) => {
      doChuansong(source, '反弹！');
    });
  });

  socket.on('chuansongSelect', ({ spaceId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!chuansongSelecting) return;
    chuansongSelecting = false;
    const targetId = chuansongState ? chuansongState.targetId : null;
    chuansongState = null;
    const target = players.find(p => p.id === targetId);
    if (!target) return;
    const space = board.find(s => s.id === spaceId);
    if (!space) return;
    const fromPos = target.position;
    target.position = spaceId;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('chuansongMove', { playerId: target.id, fromPos, toPos: spaceId, spaceName: space.name, senderId: current.id });
  });

  socket.on('fengdiCardTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!fengdiCardState || fengdiCardState.userId !== current.id || fengdiCardState.phase !== 'selectTarget') return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.sheltered || target.id === current.id) return;

    const doFengdi = (effTarget, hiddenMsg) => {
      if (!effTarget) {
        fengdiCardState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        return;
      }
      effTarget.fengdiTurns = (effTarget.fengdiTurns || 0) + 3;
      fengdiCardState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}使用封地卡令${coloredName(effTarget.name, effTarget.color)}不能买地建房，持续3回合` });
    };

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      doFengdi(finalTarget, hiddenMsg);
    }, () => {
      fengdiCardState = null;
      pendingHiddenResult = null;
    }, (source) => {
      doFengdi(source, '反弹！');
    });
  });

  socket.on('tingyeTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!tingyeState || tingyeState.userId !== current.id || tingyeState.phase !== 'selectTarget') return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || (target.sheltered && target.id !== current.id)) return;

    const doTingye = (effTarget, hiddenMsg) => {
      if (!effTarget) {
        tingyeState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        return;
      }
      const props = board.filter(s => s.isProperty && s.owner === effTarget.id);
      props.forEach(s => { s.closed = true; });
      const propNames = props.map(s => s.name).join('，');
      tingyeState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}使用停业卡令${coloredName(effTarget.name, effTarget.color)}全部地产停业` });
    };

    withHiddenCheck(socket.id, targetId, (finalTarget, hiddenMsg) => {
      doTingye(finalTarget, hiddenMsg);
    }, () => {
      tingyeState = null;
      pendingHiddenResult = null;
    }, (source) => {
      doTingye(source, '反弹！');
    });
  });

  socket.on('colorDiceChooseOneSelect', ({ diceValue }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    currentDiceValue = diceValue;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('colorDiceResult', diceValue);
  });

  socket.on('colorDiceChooseSelect', ({ diceValue }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    currentDiceValue = diceValue;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('colorDiceResult', diceValue);
  });

  socket.on('shanxianSelect', ({ spaceId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!shanxianSelecting) return;
    const BOARD_SIZE = board.length;
    const curPos = current.position;
    const validPositions = [];
    for (let i = 1; i <= 3; i++) {
      validPositions.push((curPos + i) % BOARD_SIZE);
      validPositions.push((curPos - i + BOARD_SIZE) % BOARD_SIZE);
    }
    if (!validPositions.includes(spaceId)) return;
    shanxianSelecting = false;
    const space = board[spaceId];
    if (!space) return;
    const fromPos = current.position;
    current.position = spaceId;
    const others = players.filter(p => p.id !== current.id && !p.bankrupt && !p.inJail && p.position === spaceId);
    if (others.length === 0) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用闪现卡移动到${space.name}` });
    } else {
      const bounced = [];
      others.forEach(p => {
        const newPos = Math.floor(Math.random() * BOARD_SIZE);
        p.position = newPos;
        bounced.push({ name: p.name, color: p.color, spaceName: board[newPos].name });
      });
      let msg = `${coloredName(current.name, current.color)}使用闪现卡撞飞了`;
      bounced.forEach((b, i) => {
        msg += `${i > 0 ? '，' : ''}${coloredName(b.name, b.color)}到${b.spaceName}`;
      });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: msg });
    }
  });

  socket.on('longjuanfengTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!longjuanfengState || longjuanfengState.userId !== current.id || longjuanfengState.phase !== 'selectTarget') return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || (target.sheltered && target.id !== current.id)) return;

    const doLongjuanfeng = (effTarget, hiddenMsg) => {
      if (!effTarget) {
        longjuanfengState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        return;
      }
      // 移除龙卷风卡
      const idx = current.cards.findIndex(c => c.name === '龙卷风卡');
      if (idx !== -1) current.cards.splice(idx, 1);

      setPlayerState(effTarget, 'shelteredTurns', 2);
      if (effTarget.shelteredTurns) {
        updateShelteredState();

        // 使用applyRest触发免休卡检查，skipShowEndTurn=true确保不影响使用者F区和G区
        applyRest(effTarget.id, 2, `${hiddenMsg}${coloredName(current.name, current.color)}使用龙卷风卡令${coloredName(effTarget.name, effTarget.color)}休息2回合且不可选取`, null, () => {
          longjuanfengState = null;
            // 使用者的界面保持不变（继续显示掷骰子等）
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        }, { shelterTurns: 2, skipShowEndTurn: true });
      } else {
        longjuanfengState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      }
    };

    withHiddenCheck(socket.id, targetId, (finalTarget, hiddenMsg) => {
      doLongjuanfeng(finalTarget, hiddenMsg);
    }, () => {
      longjuanfengState = null;
      pendingHiddenResult = null;
    }, (source) => {
      doLongjuanfeng(source, '反弹！');
    });
  });

  socket.on('shuimianTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!shuimianState || shuimianState.userId !== current.id || shuimianState.phase !== 'selectTarget') return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || (target.sheltered && target.id !== current.id)) return;

    const doShuimian = (effTarget, hiddenMsg) => {
      if (!effTarget) {
        shuimianState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        return;
      }
      applyRest(effTarget.id, 3, `${hiddenMsg}${coloredName(current.name, current.color)}使用睡眠卡令${coloredName(effTarget.name, effTarget.color)}休息3回合`, null, () => {
        shuimianState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      }, { skipShowEndTurn: true });
    };

    withHiddenCheck(socket.id, targetId, (finalTarget, hiddenMsg) => {
      doShuimian(finalTarget, hiddenMsg);
    }, () => {
      shuimianState = null;
      pendingHiddenResult = null;
    }, (source) => {
      doShuimian(source, '反弹！');
    });
  });

  socket.on('xianhaiTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!xianhaiState || xianhaiState.userId !== current.id || xianhaiState.phase !== 'selectTarget') return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || (target.sheltered && target.id !== current.id)) return;

    const doXianhai = (effTarget, hiddenMsg) => {
      if (!effTarget) {
        xianhaiState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        return;
      }
      sendToJail(effTarget.id, `${hiddenMsg}${coloredName(current.name, current.color)}使用陷害卡令${coloredName(effTarget.name, effTarget.color)}进监狱`, () => {
        xianhaiState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}使用陷害卡令${coloredName(effTarget.name, effTarget.color)}进监狱` });
      });
    };

    withHiddenCheck(socket.id, targetId, (finalTarget, hiddenMsg) => {
      doXianhai(finalTarget, hiddenMsg);
    }, () => {
      xianhaiState = null;
      pendingHiddenResult = null;
    }, (source) => {
      doXianhai(source, '反弹！');
    });
  });

  socket.on('bingdongTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!bingdongState || bingdongState.userId !== current.id || bingdongState.phase !== 'selectTarget') return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || (target.sheltered && target.id !== current.id)) return;

    const doBingdong = (effTarget, hiddenMsg) => {
      effTarget.bingdong = 1;
      bingdongState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}使用冰冻卡令${coloredName(effTarget.name, effTarget.color)}停留1回合` });
    };

    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      doBingdong(finalTarget, hiddenMsg);
    }, () => {
      bingdongState = null;
      pendingHiddenResult = null;
    }, (source) => {
      doBingdong(source, '反弹！');
    });
  });

  socket.on('qiangjieTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.id === current.id) return;
    
    const hiddenCard = target.cards?.find(c => c.hiddenType && ['quxiao', 'jianyuan', 'zhuanyi', 'fantan'].includes(c.hiddenType));
    
    if (hiddenCard) {
      checkHiddenCardTarget(target.id, current.id, (cancelled) => {
        if (cancelled) {
          pendingHiddenResult = null;
          return;
        }
        let finalTarget = target;
        let hiddenMsg = '';
        if (pendingHiddenResult && pendingHiddenResult.message) {
          hiddenMsg = pendingHiddenResult.message + '，';
        }
        if (pendingHiddenResult && pendingHiddenResult.newTargetId) {
          const newTarget = players.find(p => p.id === pendingHiddenResult.newTargetId);
          if (newTarget) finalTarget = newTarget;
        }
        if (pendingHiddenResult && pendingHiddenResult.type === 'fantan') {
          // 反弹：不改变拼钱对象，只标记rebound，结算时反转效果
          pinqianState = {
            currentPlayerId: current.id,
            targetPlayerId: target.id,
            currentPlayerName: current.name,
            targetPlayerName: target.name,
            currentNumber: 0,
            targetNumber: 0,
            currentConfirmed: false,
            targetConfirmed: false,
            resultType: 'qiangjie',
            hiddenMsg: hiddenMsg || '',
            rebound: true
          };
          pendingHiddenResult = null;
          io.emit('updateAreaE', { message: `${hiddenMsg || ''}${coloredName(current.name, current.color)}正在使用抢劫卡，与${coloredName(target.name, target.color)}拼钱` });
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          const currentSocket = io.sockets.sockets.get(current.id);
          if (currentSocket) {
            currentSocket.emit('pinqianStart', { playerName: current.name, playerColor: current.color, targetName: target.name, targetColor: target.color, isCurrent: true });
          }
          const targetSocket = io.sockets.sockets.get(target.id);
          if (targetSocket) {
            targetSocket.emit('pinqianStart', { playerName: current.name, playerColor: current.color, targetName: target.name, targetColor: target.color, isCurrent: false });
          }
          return;
        }
        pendingHiddenResult = null;
        startQiangjiePinqian(current, finalTarget, hiddenMsg);
      });
      return;
    }
    
    startQiangjiePinqian(current, target, '');
  });

  function startQiangjiePinqian(current, target, hiddenMsg) {
    io.emit('updateAreaE', { message: `${hiddenMsg || ''}${coloredName(current.name, current.color)}正在使用抢劫卡，与${coloredName(target.name, target.color)}拼钱` });
    
    pinqianState = {
      currentPlayerId: current.id,
      targetPlayerId: target.id,
      currentPlayerName: current.name,
      targetPlayerName: target.name,
      currentNumber: 0,
      targetNumber: 0,
      currentConfirmed: false,
      targetConfirmed: false,
      resultType: 'qiangjie',
      hiddenMsg: hiddenMsg || '',
      rebound: current.id === target.id
    };
    
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    const currentSocket = io.sockets.sockets.get(current.id);
    if (currentSocket) {
      currentSocket.emit('pinqianStart', { 
        playerName: current.name, playerColor: current.color,
        targetName: target.name, targetColor: target.color, isCurrent: true 
      });
    }
    const targetSocket = io.sockets.sockets.get(target.id);
    if (targetSocket) {
      targetSocket.emit('pinqianStart', { 
        playerName: current.name, playerColor: current.color,
        targetName: target.name, targetColor: target.color, isCurrent: false 
      });
    }
  }

  socket.on('qiangjieLoot', ({ targetId, lootType, lootIndex }) => {
    if (!qiangjieState || qiangjieState.robberId !== socket.id) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target) return;

    if (lootType === 'money') {
      const doLootMoney = (pay) => {
        if (pay) {
          previewMoney(current.id, 7);
          previewMoney(target.id, -7);
          io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}掠夺了${coloredName(target.name, target.color)}的7` });
        } else {
          io.emit('updateAreaE', { message: `${coloredName(target.name, target.color)}失去的钱＞10，保护卡令其无效` });
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        qiangjieState = null;
        socket.emit('showEndTurn');
      };
      doLootMoney(true);
      return;
    } else if (lootType === 'card' && target.cards && target.cards[lootIndex]) {
      const lootedCard = target.cards.splice(lootIndex, 1)[0];
      if (!current.cards) current.cards = [];
      addCardToPlayer(current, lootedCard);
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}掠夺了${coloredName(target.name, target.color)}的${lootedCard.name}` });
    }
    
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    qiangjieState = null;
    socket.emit('showEndTurn');
  });

  socket.on('petShopClose', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    io.emit('petShopClosed');
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}放弃了拍卖` });
    socket.emit('showEndTurn');
  });

  socket.on('sellProperty', ({ propertyId }) => {
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt || player.money >= 0) return;
    const prop = board.find(s => s.id === propertyId && s.owner === player.id);
    if (!prop) return;
    const sellPrice = Math.ceil(prop.price / 2);
    previewMoney(player.id, sellPrice);
    prop.owner = null;
    const afterSellProperty = () => {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      if (player.money < 0) {
        const myProps = board.filter(s => s.isProperty && s.owner === player.id);
        if (myProps.length > 0) {
          io.emit('nearBankrupt', { playerId: player.id, playerName: player.name, playerColor: player.color, properties: myProps.map(p => ({ id: p.id, name: p.name, price: p.price })) });
        } else {
          if (doBankrupt(player)) nextTurn();
        }
      } else {
        io.emit('nearBankruptResolved', { playerId: player.id });
      }
    };
    afterSellProperty();
    return;
  });

  function executeSansiOption(player, option, sock, targetPlayer) {
    if (option === '-10，工资+3') {
      previewMoney(player.id, -10);
      player.salary += 3;
    } else if (option === '+10，工资-3') {
      previewMoney(player.id, 10);
      player.salary = Math.max(0, player.salary - 3);
    } else if (option === '休息1回合') {
      applyRest(player.id, 1, `${coloredName(player.name, player.color)}休息1回合`, null, null, { skipShowEndTurn: true });
    } else if (option === '+7，休息1回合') {
      previewMoney(player.id, 7);
      applyRest(player.id, 1, `${coloredName(player.name, player.color)}+7，休息1回合`, null, null, { skipShowEndTurn: true });
    } else if (option === '+10，进监狱') {
      previewMoney(player.id, 10);
      const applyJail = (p) => { if (returnDiamondIfHeld(p)) io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 }); setPlayerState(p, 'inJail', true); if (p.inJail) { p.jailState = 'jail'; p.position = 1; } };
      if (!checkMianxiu(player.id, '三思进监狱', { skipShowEndTurn: true, onNotUsed: () => applyJail(player) })) {
        applyJail(player);
      }
    } else if (option === '+7，进医院') {
      previewMoney(player.id, 7);
      const applyHospital = (p) => { setPlayerState(p, 'inJail', true); if (p.inJail) { p.jailState = 'hospital'; p.position = JAIL_HOSPITAL_ID; } };
      if (!checkMianxiu(player.id, '三思进医院', { skipShowEndTurn: true, onNotUsed: () => applyHospital(player) })) {
        applyHospital(player);
      }
    } else if (option === '+6，冻结10') {
      previewMoney(player.id, 6);
      const freezeAmount = Math.min(10, player.money);
      if (freezeAmount > 0) {
        player.money -= freezeAmount;
        player.frozen = (player.frozen || 0) + freezeAmount;
      }
    } else if (option === '+5，冻结8') {
      previewMoney(player.id, 5);
      const freezeAmount = Math.min(8, player.money);
      if (freezeAmount > 0) {
        player.money -= freezeAmount;
        player.frozen = (player.frozen || 0) + freezeAmount;
      }
    } else if (option === '+15，到海南') {
      previewMoney(player.id, 15);
      const applyIsland = (p) => { setPlayerState(p, 'inJail', true); if (p.inJail) { p.jailState = 'island'; p.position = JAIL_ISLAND_ID; } };
      if (!checkMianxiu(player.id, '三思到海南', { skipShowEndTurn: true, onNotUsed: () => applyIsland(player) })) {
        applyIsland(player);
      }
    } else if (option === '解冻，-4') {
      if (player.frozen > 0) {
        previewMoney(player.id, player.frozen);
        player.frozen = 0;
      }
      previewMoney(player.id, -4);
    } else if (option === '免休卡+1，-10') {
      const card = cardData.find(c => c.id === 5);
      if (card) {
        addCardToPlayer(player, card);
      }
      previewMoney(player.id, -10);
    } else if (option === '骰子+1，给每人4') {
      const diceCards = cardData.filter(c => c.id >= 7 && c.id <= 9);
      const card = diceCards[Math.floor(Math.random() * diceCards.length)];
      if (card) {
        addCardToPlayer(player, card);
      }
      players.forEach(p => {
        if (p.id !== player.id && !p.bankrupt) {
          previewMoney(p.id, 4);
          previewMoney(player.id, -4);
        }
      });
    } else if (option === '骰子+1，工资-3') {
      const diceCards = cardData.filter(c => c.id >= 7 && c.id <= 9);
      const card = diceCards[Math.floor(Math.random() * diceCards.length)];
      if (card) {
        addCardToPlayer(player, card);
      }
      player.salary = Math.max(0, player.salary - 3);
    } else if (option === '抢劫卡+1，进监狱') {
      const robCard = cardData.find(c => c.id === 1);
      if (robCard) {
        if (!player.cards) player.cards = [];
        addCardToPlayer(player, robCard);
      }
      const applyJail = (p) => { if (returnDiamondIfHeld(p)) io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 }); setPlayerState(p, 'inJail', true); if (p.inJail) { p.jailState = 'jail'; p.position = 1; } };
      if (!checkMianxiu(player.id, '三思进监狱', { skipShowEndTurn: true, onNotUsed: () => applyJail(player) })) {
        applyJail(player);
      }
    } else if (option === '保护卡+1，给地产最少的10') {
      const protectCard = cardData.find(c => c.id === 4);
      if (protectCard) {
        if (!player.cards) player.cards = [];
        addCardToPlayer(player, protectCard);
      }
      const activePlayers = players.filter(p => !p.bankrupt);
      let minProps = Infinity;
      let candidates = [];
      for (const p of activePlayers) {
        const propCount = board.filter(s => s.isProperty && s.owner === p.id).length;
        if (propCount < minProps) { minProps = propCount; candidates = [p]; }
        else if (propCount === minProps) candidates.push(p);
      }
      if (candidates.length > 0) {
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        previewMoney(target.id, 10);
        previewMoney(player.id, -10);
        return { type: 'targetInfo', targetName: target.name, targetColor: target.color, desc: coloredName(target.name, target.color), amount: 10 };
      }
    } else if (option === '乌龟卡+1，给下家7') {
      const turtleCard = cardData.find(c => c.id === 2);
      if (turtleCard) {
        if (!player.cards) player.cards = [];
        addCardToPlayer(player, turtleCard);
      }
      const activePlayers = players.filter(p => !p.bankrupt);
      const currentIndex = activePlayers.findIndex(p => p.id === player.id);
      const nextPlayer = activePlayers[(currentIndex + 1) % activePlayers.length];
      previewMoney(nextPlayer.id, 7);
      previewMoney(player.id, -7);
    } else if (option === '倒退卡+1，后退7步') {
      const backCard = cardData.find(c => c.id === 16);
      if (backCard) {
        if (!player.cards) player.cards = [];
        addCardToPlayer(player, backCard);
      }
      if (!player.inJail) {
        const fromPos = player.position;
        let newPos = fromPos - 7;
        if (newPos < 0) newPos += BOARD_SIZE;
        player.position = newPos;
        return 'animate';
      }
    } else if (option === '免路费卡+1，冻结30') {
      const freeCard = cardData.find(c => c.id === 18);
      if (freeCard) {
        if (!player.cards) player.cards = [];
        addCardToPlayer(player, freeCard);
      }
      const freezeAmount = Math.min(30, player.money);
      if (freezeAmount > 0) {
        previewMoney(player.id, -freezeAmount);
        player.frozen = (player.frozen || 0) + freezeAmount;
      }
    } else if (option === '再动一次，冻结17') {
      player.extraTurns = (player.extraTurns || 0) + 1;
      const freezeAmount = Math.min(17, player.money);
      if (freezeAmount > 0) {
        previewMoney(player.id, -freezeAmount);
        player.frozen = (player.frozen || 0) + freezeAmount;
      }
    } else if (option === '再动一次，现金个位数归零') {
      player.extraTurns = (player.extraTurns || 0) + 1;
      const lost = player.money % 10;
      if (lost > 0) previewMoney(player.id, -lost);
      player.money = Math.floor(player.money / 10) * 10;
    } else if (option === '上家进医院，冻结14') {
      const activePlayers = players.filter(p => !p.bankrupt);
      const ci = activePlayers.findIndex(p => p.id === player.id);
      const prevP = activePlayers[(ci - 1 + activePlayers.length) % activePlayers.length];
      const applyHospital = (p) => { if (returnDiamondIfHeld(p)) io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 }); setPlayerState(p, 'inJail', true); if (p.inJail) { p.jailState = 'hospital'; p.position = JAIL_HOSPITAL_ID; } };
      if (!checkMianxiu(prevP.id, '三思进医院', { skipShowEndTurn: true, onNotUsed: () => applyHospital(prevP) })) {
        applyHospital(prevP);
      }
      const freezeAmount = Math.min(14, player.money);
      if (freezeAmount > 0) {
        previewMoney(player.id, -freezeAmount);
        player.frozen = (player.frozen || 0) + freezeAmount;
      }
    } else if (option === '上家休息1回合，-5') {
      const activePlayers = players.filter(p => !p.bankrupt);
      const ci = activePlayers.findIndex(p => p.id === player.id);
      const prevP = activePlayers[(ci - 1 + activePlayers.length) % activePlayers.length];
      applyRest(prevP.id, 1, `${coloredName(prevP.name, prevP.color)}休息1回合`, null, null, { skipShowEndTurn: true });
      previewMoney(player.id, -5);
    } else if (option === '下家休息1回合，和上家一起-4') {
      const activePlayers = players.filter(p => !p.bankrupt);
      const ci = activePlayers.findIndex(p => p.id === player.id);
      const nextP = activePlayers[(ci + 1) % activePlayers.length];
      const prevP = activePlayers[(ci - 1 + activePlayers.length) % activePlayers.length];
      applyRest(nextP.id, 1, `${coloredName(nextP.name, nextP.color)}休息1回合`, null, null, { skipShowEndTurn: true });
      previewMoney(player.id, -4);
      previewMoney(prevP.id, -4);
    } else if (option === '和下家一起进监狱') {
      const activePlayers = players.filter(p => !p.bankrupt);
      const ci = activePlayers.findIndex(p => p.id === player.id);
      const nextP = activePlayers[(ci + 1) % activePlayers.length];
      const applyJailP = (p) => { if (returnDiamondIfHeld(p)) io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 }); setPlayerState(p, 'inJail', true); if (p.inJail) { p.jailState = 'jail'; p.position = 1; } };
      if (!checkMianxiu(player.id, '三思进监狱', { skipShowEndTurn: true, onNotUsed: () => applyJailP(player) })) {
        applyJailP(player);
      }
      const applyJailN = (p) => { if (returnDiamondIfHeld(p)) io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 }); setPlayerState(p, 'inJail', true); if (p.inJail) { p.jailState = 'jail'; p.position = 1; } };
      if (!checkMianxiu(nextP.id, '三思进监狱', { skipShowEndTurn: true, onNotUsed: () => applyJailN(nextP) })) {
        applyJailN(nextP);
      }
    } else if (option === '到昆仑被仙人赐福，-12') {
      if (player.inJail) { player.inJail = false; player.jailState = null; }
      player.position = 6;
      previewMoney(player.id, -12);
      return 'arriveKunlun';
    } else if (option === '到澳门，工资-2') {
      if (player.inJail) { player.inJail = false; player.jailState = null; }
      player.position = 10;
      player.salary = Math.max(0, player.salary - 2);
    } else if (option === '上家给你7，冻结14') {
      const activePlayers = players.filter(p => !p.bankrupt);
      const currentIndex = activePlayers.findIndex(p => p.id === player.id);
      const prevPlayer = activePlayers[(currentIndex - 1 + activePlayers.length) % activePlayers.length];
      previewMoney(prevPlayer.id, -7);
      previewMoney(player.id, 7);
      const freezeAmount = Math.min(14, player.money);
      if (freezeAmount > 0) {
        player.money -= freezeAmount;
        player.frozen = (player.frozen || 0) + freezeAmount;
      }
    } else if (option === '下家给你5，休息1回合') {
      const activePlayers = players.filter(p => !p.bankrupt);
      const currentIndex = activePlayers.findIndex(p => p.id === player.id);
      const nextPlayer = activePlayers[(currentIndex + 1) % activePlayers.length];
      previewMoney(nextPlayer.id, -5);
      previewMoney(player.id, 5);
      applyRest(player.id, 1, `${coloredName(player.name, player.color)}休息1回合`, null, null, { skipShowEndTurn: true });
    } else if (option === '和上家+4，现金个位数归零') {
      const activePlayers = players.filter(p => !p.bankrupt);
      const ci = activePlayers.findIndex(p => p.id === player.id);
      const prevP = activePlayers[(ci - 1 + activePlayers.length) % activePlayers.length];
      previewMoney(player.id, 4);
      previewMoney(prevP.id, 4);
      const lost = player.money % 10;
      if (lost > 0) previewMoney(player.id, -lost);
    } else if (option === '立刻结束休息') {
      if (player.restTurns > 0) player.restTurns = 0;
      if (player.inJail) { player.inJail = false; player.jailState = null; player.position = 1; }
    } else if (option === '前进1步，给地产最少的6') {
      if (player.inJail) { player.inJail = false; player.jailState = null; }
      const fromPos = player.position;
      const newPos = (fromPos + 1) % BOARD_SIZE;
      player.position = newPos;
      previewMoney(player.id, -6);
      const activePlayers = players.filter(p => !p.bankrupt);
      let minProps = Infinity;
      let candidates = [];
      for (const p of activePlayers) {
        const propCount = board.filter(s => s.isProperty && s.owner === p.id).length;
        if (propCount < minProps) { minProps = propCount; candidates = [p]; }
        else if (propCount === minProps) candidates.push(p);
      }
      let targetInfo = null;
      if (candidates.length > 0) {
        const recipient = candidates[Math.floor(Math.random() * candidates.length)];
        previewMoney(recipient.id, 6);
        targetInfo = { type: 'targetInfo', targetName: recipient.name, targetColor: recipient.color, desc: coloredName(recipient.name, recipient.color), amount: 6 };
      }
      return { type: 'animate', targetInfo };
    } else if (option === '前进7步，休息1回合') {
      if (player.inJail) { player.inJail = false; player.jailState = null; }
      const fromPos = player.position;
      const newPos = (fromPos + 7) % BOARD_SIZE;
      player.position = newPos;
      applyRest(player.id, 1, `${coloredName(player.name, player.color)}前进7步，休息1回合`, null);
      return 'animate';
    } else if (option === '每人给你4，工资-4') {
      players.forEach(p => {
        if (p.id !== player.id && !p.bankrupt) {
          previewMoney(p.id, -4);
          previewMoney(player.id, 4);
        }
      });
      player.salary = Math.max(0, player.salary - 4);
    } else if (option === '不能买地建房3回合，+10') {
      player.fengdiTurns = (player.fengdiTurns || 0) + 3;
      previewMoney(player.id, 10);
    } else if (option === '不能买地建房3回合，工资+3') {
      player.fengdiTurns = (player.fengdiTurns || 0) + 3;
      player.salary += 3;
    } else if (option === '每人给你3，后退5步') {
      players.forEach(p => {
        if (p.id !== player.id && !p.bankrupt) {
          previewMoney(p.id, -3);
          previewMoney(player.id, 3);
        }
      });
      if (!player.inJail) {
        const fromPos = player.position;
        const newPos = (fromPos - 5 + BOARD_SIZE) % BOARD_SIZE;
        player.position = newPos;
        return 'backward';
      }
    } else if (option === '令地产最少的给你12，进监狱') {
      const activePlayers = players.filter(p => !p.bankrupt);
      let minProps = Infinity;
      let candidates = [];
      for (const p of activePlayers) {
        const propCount = board.filter(s => s.isProperty && s.owner === p.id).length;
        if (propCount < minProps) { minProps = propCount; candidates = [p]; }
        else if (propCount === minProps) candidates.push(p);
      }
      let targetInfo = null;
      if (candidates.length > 0) {
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        previewMoney(target.id, -12);
        previewMoney(player.id, 12);
        targetInfo = { type: 'targetInfo', targetName: target.name, targetColor: target.color, desc: `令${coloredName(target.name, target.color)}`, amount: 12 };
      }
      const applyJail = (p) => { if (returnDiamondIfHeld(p)) io.emit('diamondProgressUpdate', { playerId: null, playerColor: null, progress: 0 }); setPlayerState(p, 'inJail', true); if (p.inJail) { p.jailState = 'jail'; p.position = 1; } };
      if (!checkMianxiu(player.id, '三思进监狱', { skipShowEndTurn: true, onNotUsed: () => applyJail(player) })) {
        applyJail(player);
      }
      return targetInfo;
    } else if (option === '令钱最多的给你10，进医院') {
      const activePlayers = players.filter(p => !p.bankrupt);
      let maxMoney = -Infinity;
      let candidates = [];
      for (const p of activePlayers) {
        if (p.money > maxMoney) { maxMoney = p.money; candidates = [p]; }
        else if (p.money === maxMoney) candidates.push(p);
      }
      let targetInfo = null;
      if (candidates.length > 0) {
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        previewMoney(target.id, -10);
        previewMoney(player.id, 10);
        targetInfo = { type: 'targetInfo', targetName: target.name, targetColor: target.color, desc: `令${coloredName(target.name, target.color)}`, amount: 10 };
      }
      const applyHospital = (p) => { setPlayerState(p, 'inJail', true); if (p.inJail) { p.jailState = 'hospital'; p.position = 1; } };
      if (!checkMianxiu(player.id, '三思进医院', { skipShowEndTurn: true, onNotUsed: () => applyHospital(player) })) {
        applyHospital(player);
      }
      return targetInfo;
    } else if (option === '和下家一起+7，工资-3') {
      const activePlayers = players.filter(p => !p.bankrupt);
      const otherPlayer = targetPlayer || activePlayers[(activePlayers.findIndex(p => p.id === player.id) + 1) % activePlayers.length];
      previewMoney(player.id, 7);
      previewMoney(otherPlayer.id, 7);
      player.salary = Math.max(0, player.salary - 3);
    } else if (option === '到台湾，+5') {
      if (player.inJail) { player.inJail = false; player.jailState = null; }
      player.position = 8;
      previewMoney(player.id, 5);
    } else if (option === '到重庆，-5') {
      if (player.inJail) { player.inJail = false; player.jailState = null; }
      player.position = 16;
      previewMoney(player.id, -5);
    } else if (option === '休息2回合，+10') {
      applyRest(player.id, 2, `${coloredName(player.name, player.color)}休息2回合`, null, null, { skipShowEndTurn: true });
      previewMoney(player.id, 10);
    } else if (option === '休息2回合，骰子+1') {
      applyRest(player.id, 2, `${coloredName(player.name, player.color)}休息2回合`, null, null, { skipShowEndTurn: true });
      const diceId = Math.floor(Math.random() * 6) + 7;
      const diceCard = cardData.find(c => c.id === diceId);
      if (diceCard) {
        if (!player.cards) player.cards = [];
        addCardToPlayer(player, diceCard);
      }
    } else if (option === '令1块地停业，给该玩家4') {
      return { type: 'selectPropertyClosed' };
    } else if (option === '令1块地停业，冻结13') {
      return { type: 'selectPropertyClosed', freeze: 13 };
    } else if (option === '+8，随机地产路费-2') {
      const playerProps = board.filter(s => s.isProperty && s.owner === player.id);
      if (playerProps.length === 0) return { noProperty: true };
      previewMoney(player.id, 8);
      const rp = playerProps[Math.floor(Math.random() * playerProps.length)];
      rp.rentBonus = (rp.rentBonus || 0) - 2;
      return { randomPropName: rp.name };
    } else if (option === '骰子+1，随机地产路费-2') {
      const playerProps = board.filter(s => s.isProperty && s.owner === player.id);
      if (playerProps.length === 0) return { noProperty: true };
      const diceId = Math.floor(Math.random() * 6) + 7;
      const diceCard = cardData.find(c => c.id === diceId);
      if (diceCard) { if (!player.cards) player.cards = []; addCardToPlayer(player, diceCard); }
      const rp = playerProps[Math.floor(Math.random() * playerProps.length)];
      rp.rentBonus = (rp.rentBonus || 0) - 2;
      return { randomPropName: rp.name };
    } else if (option === '和下家一起+6，随机地产路费-1') {
      const playerProps = board.filter(s => s.isProperty && s.owner === player.id);
      if (playerProps.length === 0) return { noProperty: true };
      const senderIdx = players.findIndex(p => p.id === player.id);
      let nextIdx = (senderIdx + 1) % players.length;
      while (nextIdx !== senderIdx && players[nextIdx].bankrupt) nextIdx = (nextIdx + 1) % players.length;
      if (nextIdx !== senderIdx) { previewMoney(player.id, 6); previewMoney(players[nextIdx].id, 6); }
      const rp = playerProps[Math.floor(Math.random() * playerProps.length)];
      rp.rentBonus = (rp.rentBonus || 0) - 1;
      return { randomPropName: rp.name };
    } else if (option === '现金补充到最近的10的倍数，随机地产路费-1') {
      const playerProps = board.filter(s => s.isProperty && s.owner === player.id);
      if (playerProps.length === 0) return { noProperty: true };
      const remainder = player.money % 10;
      if (remainder !== 0) previewMoney(player.id, 10 - remainder);
      const rp = playerProps[Math.floor(Math.random() * playerProps.length)];
      rp.rentBonus = (rp.rentBonus || 0) - 1;
      return { randomPropName: rp.name };
    } else if (option === '随机地产路费+2，给每人4') {
      const playerProps = board.filter(s => s.isProperty && s.owner === player.id);
      if (playerProps.length === 0) return { noProperty: true };
      players.forEach(p => { if (p.id !== player.id && !p.bankrupt) { previewMoney(p.id, 4); previewMoney(player.id, -4); } });
      const rp = playerProps[Math.floor(Math.random() * playerProps.length)];
      rp.rentBonus = (rp.rentBonus || 0) + 2;
      return { randomPropName: rp.name };
    } else if (option === '随机地产停业，+4') {
      const playerProps = board.filter(s => s.isProperty && s.owner === player.id);
      if (playerProps.length === 0) return { noProperty: true };
      const randomProp = playerProps[Math.floor(Math.random() * playerProps.length)];
      randomProp.closed = true;
      previewMoney(player.id, 4);
    } else if (option === '随机地产停业，工资+2') {
      const playerProps = board.filter(s => s.isProperty && s.owner === player.id);
      if (playerProps.length === 0) return { noProperty: true };
      const randomProp = playerProps[Math.floor(Math.random() * playerProps.length)];
      randomProp.closed = true;
      player.salary = (player.salary || 0) + 2;
    } else if (option === '木门[需钥匙]：+18，工资+5') {
      const keyIdx = player.cards ? player.cards.findIndex(c => c.id === 13) : -1;
      if (keyIdx === -1) return { type: 'noKey' };
      player.cards.splice(keyIdx, 1);
      previewMoney(player.id, 18);
      player.salary = (player.salary || 0) + 5;
    } else if (option === '-10，临时金钱+20') {
      deductMoney(player.id, 10);
      grantTempMoney(player.id, 20, 3);
    } else if (option === '休息1回合，临时金钱+8') {
      applyRest(player.id, 1, `${coloredName(player.name, player.color)}休息1回合`, null, null, { skipShowEndTurn: true });
      grantTempMoney(player.id, 8, 3);
    } else if (option === '工资-3，临时金钱+10') {
      player.salary = Math.max(0, player.salary - 3);
      grantTempMoney(player.id, 10, 3);
    } else if (option === '冻结20，临时金钱+10') {
      const freezeAmount = Math.min(20, player.money);
      if (freezeAmount > 0) {
        player.money -= freezeAmount;
        player.frozen = (player.frozen || 0) + freezeAmount;
      }
      grantTempMoney(player.id, 10, 3);
    } else if (option === '随机移除自己1个状态') {
      const removableStatuses = [];
      if (player.extraTurns > 0) removableStatuses.push('extraTurns');
      if (player.fuwufeiExtraMove) removableStatuses.push('fuwufeiExtraMove');
      if (player.restTurns > 0) removableStatuses.push('restTurns');
      if (player.sheltered) removableStatuses.push('sheltered');
      if (player.shihua) removableStatuses.push('shihua');
      if (player.guhuoDice) removableStatuses.push('guhuoDice');
      if (player.shoumaiDice) removableStatuses.push('shoumaiDice');
      if (player.yinyueDice) removableStatuses.push('yinyueDice');
      if (player.shijieWar) removableStatuses.push('shijieWar');
      if (player.hezongState === 'forced' || player.hezongState === 'normal') removableStatuses.push('hezongState');
      if (player.diceEffects && player.diceEffects.length > 0) removableStatuses.push('diceEffects');
      if (player.daotui) removableStatuses.push('daotui');
      if (player.bingdong > 0) removableStatuses.push('bingdong');
      if (player.bomingFrozen) removableStatuses.push('bomingFrozen');
      if (player.jinzu) removableStatuses.push('jinzu');
      if (player.tuolei && player.tuolei.turns > 0) removableStatuses.push('tuolei');
      if (player.wenjigifwu) removableStatuses.push('wenjigifwu');
      if (player.dizhuTurns > 0) removableStatuses.push('dizhuTurns');
      if (player.fengkongDice && player.fengkongDice.length > 0) removableStatuses.push('fengkongDice');
      if (player.syncedDice) removableStatuses.push('syncedDice');
      if (player.cunqianList && player.cunqianList.length > 0) removableStatuses.push('cunqianList');
      if (player.tempMoney && player.tempMoney > 0 && player.tempTurns > 0) removableStatuses.push('tempMoney');
      if (player.protectedAsset) removableStatuses.push('protectedAsset');
      if (player.inJail) removableStatuses.push('inJail');
      if (removableStatuses.length > 0) {
        const removed = removableStatuses[Math.floor(Math.random() * removableStatuses.length)];
        const removedNames = {
          extraTurns: '再动次数', fuwufeiExtraMove: '服务费再动', restTurns: '休息',
          sheltered: '避难', shihua: '石化', guhuoDice: '蛊惑骰子',
          shoumaiDice: '受卖骰子', yinyueDice: '音乐指挥骰子', shijieWar: '世界大战',
          hezongState: '合纵', diceEffects: '骰子效果', daotui: '倒退',
          bingdong: '冰冻', bomingFrozen: '搏命冻结', jinzu: '禁足',
          tuolei: '拖累', wenjigifwu: '闻鸡起舞', dizhuTurns: '地主',
          fengkongDice: '封控骰子', syncedDice: '同步骰子', cunqianList: '存钱',
          tempMoney: '临时金钱', protectedAsset: '保护资产', inJail: '囚牢'
        };
        switch (removed) {
          case 'extraTurns': player.extraTurns = 0; break;
          case 'fuwufeiExtraMove': player.fuwufeiExtraMove = false; break;
          case 'restTurns': player.restTurns = 0; break;
          case 'sheltered': player.sheltered = false; player.shelteredTurns = 0; break;
          case 'shihua': player.shihua = false; break;
          case 'guhuoDice': player.guhuoDice = null; player.guhuoBy = null; break;
          case 'shoumaiDice': player.shoumaiDice = null; break;
          case 'yinyueDice': player.yinyueDice = null; player.yinyueBy = null; break;
          case 'shijieWar': player.shijieWar = false; break;
          case 'hezongState': player.hezongState = null; player.hezongTurns = 0; player.hezongTarget = null; break;
          case 'diceEffects': player.diceEffects = []; break;
          case 'daotui': player.daotui = false; break;
          case 'bingdong': player.bingdong = 0; break;
          case 'bomingFrozen': player.bomingFrozen = false; break;
          case 'jinzu': player.jinzu = false; break;
          case 'tuolei': player.tuolei = null; break;
          case 'wenjigifwu': player.wenjigifwu = false; break;
          case 'dizhuTurns': player.dizhuTurns = 0; break;
          case 'fengkongDice': player.fengkongDice = []; break;
          case 'syncedDice': player.syncedDice = null; player.syncedByName = null; break;
          case 'cunqianList': player.cunqianList = []; break;
          case 'tempMoney': player.tempMoney = 0; player.tempTurns = 0; break;
          case 'protectedAsset': player.protectedAsset = null; player.protectedAssetName = null; break;
          case 'inJail': player.inJail = false; player.jailState = null; player.position = 1; break;
        }
        return { type: 'removedStatus', removedName: removedNames[removed] || removed };
      }
      // 无可移除状态，什么都不做
    } else if (option === '获得灾厄3回合，工资+3') {
      player.zaie = (player.zaie || 0) + 3;
      player.salary = (player.salary || 0) + 3;
    } else if (option === '获得灾厄3回合，+10') {
      player.zaie = (player.zaie || 0) + 3;
      previewMoney(player.id, 10);
    }
  }

  socket.on('buildHouse', (choice) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (current.fengdiTurns > 0) {
      io.emit('updateAreaE', { message: '封地禁令，无法购买地产/建房' });
      socket.emit('showEndTurn');
      return;
    }
    const space = board.find(s => s.id === current.position);
    
    if (choice === 'build' && space && space.owner === current.id) {
      const buildCost = Math.round(space.price / 4);
      if (current.money >= buildCost) {
        previewMoney(current.id, -buildCost);
        space.houseLevel = (space.houseLevel || 0) + 1;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}花${buildCost}建房` });
      }
    }
  });

  socket.on('useJianfang', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const cardIdx = current.cards ? current.cards.findIndex(c => c.name === '建房卡') : -1;
    if (cardIdx === -1) return;
    const space = board.find(s => s.id === current.position);
    if (!space || space.owner !== current.id || space.houseLevel >= 4) return;
    current.cards.splice(cardIdx, 1);
    space.houseLevel = (space.houseLevel || 0) + 1;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用建房卡免费建房` });
    socket.emit('showEndTurn');
  });

  socket.on('buyProperty', ({ propertyId } = {}) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;

    let space;
    if (propertyId != null) {
      space = board[propertyId];
    } else {
      const currentPos = current.position;
      space = board[currentPos];
    }

    if (!space || space.type !== 'property' || !space.isProperty || space.owner) {
      socket.emit('error', '无法购买该地产');
      return;
    }

    // 检查总金钱（临时金钱 + 现金）是否足够
    const totalMoney = (current.tempMoney || 0) + current.money;
    if (totalMoney < space.price) {
      socket.emit('error', '余额不足，无法购买');
      return;
    }

    // 使用 doDeduct 函数扣款，优先扣临时金钱
    doDeduct(current.id, space.price);
    space.owner = current.id;

    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}花${space.price}购买了${space.name}` });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('showEndTurn');
  });

  socket.on('siheyuanReveal', (cardIndex) => {
    if (!siheyuanState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (cardIndex < 0 || cardIndex >= 4) return;
    if (siheyuanState.revealed[cardIndex]) return;
    if (siheyuanState.isTianhu) return;

    previewMoney(current.id, -3);
    siheyuanState.revealed[cardIndex] = true;
    siheyuanState.allRevealedSuits.add(siheyuanState.row3Suits[cardIndex]);

    const suits = ['hongtao', 'meihua', 'fangkuai', 'heitao'];
    const suitSymbols = { hongtao: '♥', meihua: '♣', fangkuai: '♦', heitao: '♠' };
    const missingSuits = suits.filter(s => !siheyuanState.allRevealedSuits.has(s));
    const allCollected = missingSuits.length === 0;

    if (allCollected) {
      previewMoney(current.id, 15);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}集齐四合院！+15` });
      socket.emit('siheyuanResult', { cardIndex, suit: siheyuanState.row3Suits[cardIndex], allCollected: true });
      io.emit('siheyuanWatchUpdate', { cardIndex, suit: siheyuanState.row3Suits[cardIndex] });
      siheyuanState = null;
      return;
    }

    const allRevealed = siheyuanState.revealed.every(r => r);
    if (allRevealed) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `失败，一共-15` });
      socket.emit('siheyuanResult', { cardIndex, suit: siheyuanState.row3Suits[cardIndex], allCollected: false, allRevealed: true });
      io.emit('siheyuanWatchUpdate', { cardIndex, suit: siheyuanState.row3Suits[cardIndex] });
      siheyuanState = null;
      return;
    }

    const missingSymbols = missingSuits.map(s => suitSymbols[s]).join('');
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `-3，还差${missingSymbols}` });
    socket.emit('siheyuanResult', { cardIndex, suit: siheyuanState.row3Suits[cardIndex], allCollected: false, missingSuits, playerName: current.name, playerColor: current.color });
    io.emit('siheyuanWatchUpdate', { cardIndex, suit: siheyuanState.row3Suits[cardIndex], revealed: siheyuanState.revealed, allCollected: false, playerName: current.name, playerColor: current.color });
  });

  socket.on('siheyuanGiveUp', () => {
    if (!siheyuanState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('siheyuanGiveUpResult', { playerName: current.name, playerColor: current.color });
    io.emit('siheyuanWatchGiveUp', { playerName: current.name, playerColor: current.color });
    siheyuanState = null;
  });

  socket.on('siheyuanCloseFromClient', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    siheyuanState = null;
    io.emit('siheyuanClose');
  });

  socket.on('siheyuanEnd', () => {
    if (!siheyuanState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    siheyuanState = null;
    socket.emit('showEndTurn');
  });

  socket.on('wuyueBuild', (spaceId) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.id === spaceId);
    if (!space || space.owner !== current.id) return;
    if (space.houseLevel >= 4) return;
    const buildCost = Math.round(space.price / 4);
    previewMoney(current.id, -buildCost);
    space.houseLevel++;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    socket.emit('wuyueAfterBuild', { spaceName: space.name, houseLevel: space.houseLevel });
  });

  socket.on('wuyueReform', (spaceId) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.id === spaceId);
    if (!space || space.owner !== current.id) return;
    socket.emit('wuyueReformPanel', { spaceId, spaceName: space.name });
  });

  socket.on('wuyueReformSelect', ({ spaceId, mountainName, mountainDesc }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.id === spaceId);
    if (!space || space.owner !== current.id) return;
    space.name = mountainName;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${space.name}改造成功！` });
    socket.emit('wuyueReformDone', { mountainName, mountainDesc, spaceId });
  });

  socket.on('startSalary', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    current.salary += 2;
    current.petFlipped = false;
    if (current.petImage) {
      const info = getPetInfo(current.petImage);
      if (info && info.name === '影魔') current.yingmoCharges = 3;
    }
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}工资+2` });
    socket.emit('showEndTurn');
  });

  socket.on('startQiyu', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (Math.random() > 1/6) {
      io.emit('updateAreaE', { message: '奇遇难遇' });
      socket.emit('showEndTurn');
      return;
    }
    const selectedQiyu = weightedRandomQiyu();
    socket.emit('qiyuDrawAnimation', { qiyuId: selectedQiyu.id, qiyuName: selectedQiyu.name, qiyuDesc: selectedQiyu.desc });
  });

  socket.on('nextQiyu', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const selectedQiyu = qiyuList[qiyuIndex % qiyuList.length];
    qiyuIndex++;
    socket.emit('qiyuDrawAnimation', { qiyuId: selectedQiyu.id, qiyuName: selectedQiyu.name, qiyuDesc: selectedQiyu.desc });
  });

  socket.on('qiyuTestSelect', ({ qiyuId }) => {
    processQiyu(qiyuId, socket);
  });

  socket.on('gaokaoAdd', (value) => {
    if (!gaokaoState) return;
    const entry = gaokaoState.players.find(p => p.id === socket.id);
    if (!entry || entry.confirmed) return;
    const player = players.find(p => p.id === socket.id);
    entry.number += value;
    if (player && entry.number > player.money) entry.number = player.money;
    socket.emit('gaokaoUpdate', { number: entry.number });
  });

  socket.on('gaokaoClear', () => {
    if (!gaokaoState) return;
    const entry = gaokaoState.players.find(p => p.id === socket.id);
    if (!entry || entry.confirmed) return;
    entry.number = 0;
    socket.emit('gaokaoUpdate', { number: 0 });
  });

  socket.on('gaokaoConfirmWithValue', (value) => {
    if (!gaokaoState) return;
    const entry = gaokaoState.players.find(p => p.id === socket.id);
    if (!entry || entry.confirmed) return;
    const numValue = parseInt(value) || 0;
    if (numValue <= 0) return;
    entry.number = numValue;
    entry.confirmed = true;
    socket.emit('gaokaoConfirmed');

    if (gaokaoState.players.every(p => p.confirmed)) {
      const sorted = [...gaokaoState.players].sort((a, b) => b.number - a.number);
      const results = [];
      let currentRank = 0;
      let prevNumber = null;
      sorted.forEach((entry, index) => {
        const player = players.find(p => p.id === entry.id);
        if (!player) return;
        previewMoney(player.id, -entry.number);
        if (prevNumber !== entry.number) {
          currentRank = index + 1;
        }
        const reward = currentRank - 1 < gaokaoState.rewards.length ? gaokaoState.rewards[currentRank - 1] : gaokaoState.rewards[gaokaoState.rewards.length - 1];
        if (reward !== 0) {
          previewMoney(player.id, reward);
        }
        results.push(`${coloredName(entry.name, entry.color)}-${entry.number}${reward >= 0 ? '+' : ''}${reward}`);
        prevNumber = entry.number;
      });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('gaokaoEnd', { message: results.join('，') });
      const current = players[currentPlayerIndex];
      if (current) {
        const s = io.sockets.sockets.get(current.id);
        if (s) s.emit('showEndTurn');
      }
      gaokaoState = null;
    }
  });

  socket.on('yexinjiaSelect', ({ choice }) => {
    if (!yexinjiaState) return;
    const entry = yexinjiaState.playerIds.find(id => id === socket.id);
    if (!entry) return;
    if (yexinjiaState.choices[socket.id] !== undefined) return;
    yexinjiaState.choices[socket.id] = choice;

    if (Object.keys(yexinjiaState.choices).length === yexinjiaState.playerIds.length) {
      const plus10Players = [];
      const fight60Players = [];
      yexinjiaState.playerIds.forEach(id => {
        const p = players.find(pl => pl.id === id);
        if (!p) return;
        if (yexinjiaState.choices[id] === 'plus10') {
          previewMoney(p.id, 10);
          plus10Players.push(p);
        } else {
          fight60Players.push(p);
        }
      });
      const resultParts = [];
      plus10Players.forEach(p => {
        resultParts.push(`${coloredName(p.name, p.color)}+10`);
      });
      if (fight60Players.length === 1) {
        previewMoney(fight60Players[0].id, 60);
        resultParts.push(`${coloredName(fight60Players[0].name, fight60Players[0].color)}+60`);
      } else if (fight60Players.length > 1) {
        const names = fight60Players.map(p => coloredName(p.name, p.color)).join('，');
        resultParts.push(`${names}争夺60失败`);
      }
      io.emit('updateAreaE', { message: resultParts.join('，') });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      const current = players[currentPlayerIndex];
      if (current) {
        const s = io.sockets.sockets.get(current.id);
        if (s) s.emit('showEndTurn');
      }
      yexinjiaState = null;
    }
  });

  socket.on('cishanjiaSelect', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    const doCishanjia = (finalTarget, hiddenMsg) => {
      if (finalTarget.id === current.id) {
        io.emit('updateAreaE', { message: `${hiddenMsg}慈善取消` });
        socket.emit('showEndTurn');
        return;
      }
      const giveAmount = current.money;
      if (giveAmount > 0) {
        previewMoney(current.id, -giveAmount);
        previewMoney(finalTarget.id, giveAmount);
      }
      previewMoney(current.id, 50);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}把现金给${coloredName(finalTarget.name, finalTarget.color)}，+50` });
      socket.emit('showEndTurn');
    };

    const hiddenCard = target.cards?.find(c => c.hiddenType && ['quxiao', 'jianyuan', 'zhuanyi', 'fantan'].includes(c.hiddenType));
    if (hiddenCard) {
      checkHiddenCardTarget(target.id, current.id, (cancelled) => {
        if (cancelled) {
          socket.emit('showEndTurn');
          pendingHiddenResult = null;
          return;
        }
        let finalTarget = target;
        let hiddenMsg = '';
        if (pendingHiddenResult && pendingHiddenResult.message) {
          hiddenMsg = pendingHiddenResult.message + '，';
        }
        if (pendingHiddenResult && pendingHiddenResult.newTargetId) {
          const newTarget = players.find(p => p.id === pendingHiddenResult.newTargetId);
          if (newTarget && !newTarget.bankrupt && newTarget.id !== current.id) finalTarget = newTarget;
        }
        if (pendingHiddenResult && pendingHiddenResult.type === 'fantan') {
          finalTarget = current;
        }
        pendingHiddenResult = null;
        doCishanjia(finalTarget, hiddenMsg);
      });
      return;
    }

    doCishanjia(target, '');
  });

  socket.on('jiubaSelect', ({ choice }) => {
    if (!jiuBaState) return;
    if (!jiuBaState.playerIds.includes(socket.id)) return;
    if (jiuBaState.choices[socket.id] !== undefined) return;
    jiuBaState.choices[socket.id] = choice;

    if (Object.keys(jiuBaState.choices).length === jiuBaState.playerIds.length) {
      const barPlayers = [];
      const homePlayers = [];
      jiuBaState.playerIds.forEach(id => {
        const p = players.find(pl => pl.id === id);
        if (!p) return;
        if (jiuBaState.choices[id] === 'bar') {
          barPlayers.push(p);
        } else {
          homePlayers.push(p);
        }
      });
      const resultParts = [];
      const halfCount = Math.floor(jiuBaState.totalPlayers / 2);
      if (barPlayers.length > 0 && barPlayers.length <= halfCount) {
        barPlayers.forEach(p => {
          previewMoney(p.id, 35);
          resultParts.push(`${coloredName(p.name, p.color)}+35`);
        });
        homePlayers.forEach(p => {
          previewMoney(p.id, 5);
          resultParts.push(`${coloredName(p.name, p.color)}+5`);
        });
      } else {
        homePlayers.forEach(p => {
          previewMoney(p.id, 5);
          resultParts.push(`${coloredName(p.name, p.color)}+5`);
        });
        if (barPlayers.length > 0) {
          const barNames = barPlayers.map(p => coloredName(p.name, p.color)).join('，');
          resultParts.push(`${barNames}去酒吧失败`);
        }
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: resultParts.join('，') });
      const current = players[currentPlayerIndex];
      if (current) {
        const s = io.sockets.sockets.get(current.id);
        if (s) s.emit('showEndTurn');
      }
      jiuBaState = null;
    }
  });

  socket.on('yihuaSelectSource', ({ propertyId }) => {
    if (!yihuaState || yihuaState.phase !== 'selectSource') return;
    if (socket.id !== yihuaState.commanderId) return;
    const prop = board.find(s => s.id === propertyId);
    if (!prop || !prop.isProperty || prop.owner === socket.id || prop.houseLevel <= 0) return;
    yihuaState.sourceId = propertyId;
    yihuaState.phase = 'selectTarget';
    io.emit('updateAreaE', { message: '移动到哪里？' });
    const s = io.sockets.sockets.get(yihuaState.commanderId);
    if (s) s.emit('yihuaSelectTarget', { sourceName: prop.name });
  });

  socket.on('yihuaSelectTarget', ({ propertyId }) => {
    if (!yihuaState || yihuaState.phase !== 'selectTarget') return;
    if (socket.id !== yihuaState.commanderId) return;
    const targetProp = board.find(s => s.id === propertyId);
    if (!targetProp || !targetProp.isProperty || targetProp.owner !== socket.id) return;
    const sourceProp = board.find(s => s.id === yihuaState.sourceId);
    if (!sourceProp) return;
    targetProp.houseLevel += sourceProp.houseLevel;
    if (targetProp.houseLevel > 4) targetProp.houseLevel = 4;
    const sourceName = sourceProp.name;
    const targetName = targetProp.name;
    sourceProp.houseLevel = 0;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `将${sourceName}的房屋移动到${targetName}` });
    const current = players[currentPlayerIndex];
    if (current) {
      const s = io.sockets.sockets.get(current.id);
      if (s) s.emit('showEndTurn');
    }
    yihuaState = null;
  });

  socket.on('hebaoSelectRow', ({ row }) => {
    if (!hebaoState) return;
    if (socket.id !== hebaoState.commanderId) return;
    const rowMap = {
      1: [3, 4, 5],
      2: [8, 9, 10],
      3: [13, 15, 16, 17],
      4: [21, 22, 23],
      5: [27, 28, 29],
      6: [31, 33, 34, 35]
    };
    const ids = rowMap[row];
    if (!ids) return;
    ids.forEach(id => {
      const space = board.find(s => s.id === id);
      if (space) {
        space.owner = null;
        space.houseLevel = 0;
      }
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `核爆炸：第${row}排地产被摧毁` });
    const current = players[currentPlayerIndex];
    if (current) {
      const s = io.sockets.sockets.get(current.id);
      if (s) s.emit('showEndTurn');
    }
    hebaoState = null;
  });

  socket.on('huanranSelectRow', ({ row }) => {
    if (!huanranState) return;
    if (socket.id !== huanranState.commanderId) return;
    const rowMap = {
      1: [3, 4, 5],
      2: [8, 9, 10],
      3: [13, 15, 16, 17],
      4: [21, 22, 23],
      5: [27, 28, 29],
      6: [31, 33, 34, 35]
    };
    const ids = rowMap[row];
    if (!ids) return;
    const upgraded = [];
    ids.forEach(id => {
      const space = board.find(s => s.id === id);
      if (space && space.isProperty && space.houseLevel < 4) {
        space.houseLevel += 1;
        upgraded.push(space.name);
      }
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `焕然一新：${upgraded.join('，')}升级` });
    const current = players[currentPlayerIndex];
    if (current) {
      const s = io.sockets.sockets.get(current.id);
      if (s) s.emit('showEndTurn');
    }
    huanranState = null;
  });

  socket.on('shengdongDeclare', ({ propId }) => {
    if (!shengdongState || socket.id !== shengdongState.commanderId) return;
    const prop = board.find(s => s.id === propId);
    if (!prop || !prop.isProperty || prop.owner !== shengdongState.targetId) return;
    shengdongState.declared = propId;
    const current = players[currentPlayerIndex];
    const target = players.find(p => p.id === shengdongState.targetId);
    io.emit('updateAreaE', { message: `声明的地产是${prop.name}，${coloredName(current.name, current.color)}进攻，${coloredName(target.name, target.color)}保护` });
    socket.emit('shengdongAttackBoard', { targetId: shengdongState.targetId });
    const targetSocket = io.sockets.sockets.get(shengdongState.targetId);
    if (targetSocket) targetSocket.emit('shengdongProtectBoard', { targetId: shengdongState.targetId });
  });

  socket.on('shengdongAttack', ({ propId }) => {
    if (!shengdongState || socket.id !== shengdongState.commanderId) return;
    const prop = board.find(s => s.id === propId);
    if (!prop || !prop.isProperty || prop.owner !== shengdongState.targetId) return;
    shengdongState.attacked = propId;
    socket.emit('shengdongAttackDone', { propName: prop.name });
    checkShengdongResolve();
  });

  socket.on('qiyuTargetSelect', ({ targetId, qiyuId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    const doQiyuEffect = (finalTarget, hiddenMsg) => {
      const t = finalTarget.id === current.id ? current : finalTarget;
      if (qiyuId === 15) {
        const halfCurrent = Math.floor(current.money / 2);
        const halfTarget = Math.floor(t.money / 2);
        previewMoney(current.id, -halfCurrent);
        previewMoney(t.id, -halfTarget);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${hiddenMsg}${current.name}和${t.name}现金减半` });
        socket.emit('showEndTurn');
      } else if (qiyuId === 16) {
        const bonusCurrent = Math.floor(current.money * 0.5);
        const bonusTarget = Math.floor(t.money * 0.5);
        previewMoney(current.id, bonusCurrent);
        previewMoney(t.id, bonusTarget);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${hiddenMsg}${current.name}和${t.name}现金+50%` });
        socket.emit('showEndTurn');
      } else if (qiyuId === 17) {
        const freezeAmount = Math.min(80, t.money);
        t.frozen = (t.frozen || 0) + freezeAmount;
        t.money -= freezeAmount;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${hiddenMsg}${t.name}被冻结${freezeAmount}` });
        socket.emit('showEndTurn');
      } else if (qiyuId === 36) {
        const targetProps = board.filter(s => s.isProperty && s.owner === t.id);
        if (targetProps.length === 0) {
          io.emit('updateAreaE', { message: `${hiddenMsg}目标没有地产` });
          socket.emit('showEndTurn');
          return;
        }
        const shuffled = targetProps.sort(() => Math.random() - 0.5);
        const count = Math.min(2, shuffled.length);
        const stolen = shuffled.slice(0, count);
        const names = stolen.map(s => s.name);
        stolen.forEach(s => {
          withPropertyProtection(t.id, () => { s.owner = current.id; });
        });
        const doEnd = () => {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}获得${coloredName(t.name, t.color)}的${names.join('，')}` });
          socket.emit('showEndTurn');
        };
        doEnd();
      } else if (qiyuId === 43) {
        lihunState.targetId = t.id;
        const allProps = board.filter(s => s.isProperty && (s.owner === current.id || s.owner === t.id));
        const propData = allProps.map(s => ({ id: s.id, name: s.name, rent: getRent(s), owner: s.owner }));
        io.emit('updateAreaE', { message: `${hiddenMsg}离婚：${coloredName(t.name, t.color)}请将地产分成两份` });
        io.emit('lihunPanel', { commanderId: current.id, commanderName: current.name, commanderColor: current.color, targetId: t.id, targetName: t.name, targetColor: t.color, properties: propData });
      } else if (qiyuId === 41) {
        shengdongState.targetId = t.id;
        io.emit('updateAreaE', { message: `${hiddenMsg}请声明1个地产` });
        socket.emit('shengdongDeclareBoard', { targetId: t.id });
      }
    };

    withHiddenCheck(current.id, target.id, doQiyuEffect, () => { socket.emit('showEndTurn'); }, (source) => { doQiyuEffect(source, '反弹，'); });
  });

  socket.on('gaokaoAdd', (value) => {
    if (!gaokaoState) return;
    const entry = gaokaoState.players.find(p => p.id === socket.id);
    if (!entry || entry.confirmed) return;
    const player = players.find(p => p.id === socket.id);
    entry.number += value;
    if (player && entry.number > player.money) entry.number = player.money;
    socket.emit('gaokaoUpdate', { number: entry.number });
  });

  socket.on('gaokaoClear', () => {
    if (!gaokaoState) return;
    const entry = gaokaoState.players.find(p => p.id === socket.id);
    if (!entry || entry.confirmed) return;
    entry.number = 0;
    socket.emit('gaokaoUpdate', { number: 0 });
  });

  socket.on('gaokaoConfirmWithValue', (value) => {
    if (!gaokaoState) return;
    const entry = gaokaoState.players.find(p => p.id === socket.id);
    if (!entry || entry.confirmed) return;
    const numValue = parseInt(value) || 0;
    if (numValue <= 0) return;
    entry.number = numValue;
    entry.confirmed = true;
    socket.emit('gaokaoConfirmed');

    if (gaokaoState.players.every(p => p.confirmed)) {
      const sorted = [...gaokaoState.players].sort((a, b) => b.number - a.number);
      const results = [];
      sorted.forEach((entry, index) => {
        const player = players.find(p => p.id === entry.id);
        if (!player) return;
        previewMoney(player.id, -entry.number);
        const reward = index < gaokaoState.rewards.length ? gaokaoState.rewards[index] : gaokaoState.rewards[gaokaoState.rewards.length - 1];
        if (reward !== 0) {
          previewMoney(player.id, reward);
        }
        results.push(`${coloredName(entry.name, entry.color)}-${entry.number}${reward >= 0 ? '+' : ''}${reward}`);
      });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('gaokaoEnd', { message: results.join('，') });
      const current = players[currentPlayerIndex];
      if (current) {
        const s = io.sockets.sockets.get(current.id);
        if (s) s.emit('showEndTurn');
      }
      gaokaoState = null;
    }
  });

  socket.on('yexinjiaSelect', ({ choice }) => {
    if (!yexinjiaState) return;
    const entry = yexinjiaState.playerIds.find(id => id === socket.id);
    if (!entry) return;
    if (yexinjiaState.choices[socket.id] !== undefined) return;
    yexinjiaState.choices[socket.id] = choice;

    if (Object.keys(yexinjiaState.choices).length === yexinjiaState.playerIds.length) {
      const plus10Players = [];
      const fight60Players = [];
      yexinjiaState.playerIds.forEach(id => {
        const p = players.find(pl => pl.id === id);
        if (!p) return;
        if (yexinjiaState.choices[id] === 'plus10') {
          previewMoney(p.id, 10);
          plus10Players.push(p);
        } else {
          fight60Players.push(p);
        }
      });
      if (fight60Players.length === 1) {
        previewMoney(fight60Players[0].id, 60);
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      const parts = [];
      if (plus10Players.length > 0) {
        parts.push(plus10Players.map(p => coloredName(p.name, p.color)).join('，') + '+10');
      }
      if (fight60Players.length === 1) {
        parts.push(coloredName(fight60Players[0].name, fight60Players[0].color) + '+60');
      } else if (fight60Players.length > 1) {
        parts.push('全体争夺60失败');
      }
      io.emit('updateAreaE', { message: parts.join('，') });
      io.emit('yexinjiaEnd');
      const current = players[currentPlayerIndex];
      if (current) {
        const s = io.sockets.sockets.get(current.id);
        if (s) s.emit('showEndTurn');
      }
      yexinjiaState = null;
    }
  });

  socket.on('cishanjiaSelect', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    const doCishanjia = (finalTarget, hiddenMsg) => {
      if (finalTarget.id === current.id) {
        io.emit('updateAreaE', { message: `${hiddenMsg}慈善取消` });
        socket.emit('showEndTurn');
        return;
      }
      const giveAmount = current.money;
      if (giveAmount > 0) {
        previewMoney(current.id, -giveAmount);
        previewMoney(finalTarget.id, giveAmount);
      }
      previewMoney(current.id, 50);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}把现金给${coloredName(finalTarget.name, finalTarget.color)}，+50` });
      socket.emit('showEndTurn');
    };

    const hiddenCard = target.cards?.find(c => c.hiddenType && ['quxiao', 'jianyuan', 'zhuanyi', 'fantan'].includes(c.hiddenType));
    if (hiddenCard) {
      checkHiddenCardTarget(target.id, current.id, (cancelled) => {
        if (cancelled) {
          socket.emit('showEndTurn');
          pendingHiddenResult = null;
          return;
        }
        let finalTarget = target;
        let hiddenMsg = '';
        if (pendingHiddenResult && pendingHiddenResult.message) {
          hiddenMsg = pendingHiddenResult.message + '，';
        }
        if (pendingHiddenResult && pendingHiddenResult.newTargetId) {
          const newTarget = players.find(p => p.id === pendingHiddenResult.newTargetId);
          if (newTarget && !newTarget.bankrupt && newTarget.id !== current.id) finalTarget = newTarget;
        }
        if (pendingHiddenResult && pendingHiddenResult.type === 'fantan') {
          finalTarget = current;
        }
        pendingHiddenResult = null;
        doCishanjia(finalTarget, hiddenMsg);
      });
      return;
    }

    doCishanjia(target, '');
  });

  socket.on('jiubaSelect', ({ choice }) => {
    if (!jiuBaState) return;
    if (!jiuBaState.playerIds.includes(socket.id)) return;
    if (jiuBaState.choices[socket.id] !== undefined) return;
    jiuBaState.choices[socket.id] = choice;

    if (Object.keys(jiuBaState.choices).length === jiuBaState.playerIds.length) {
      const barPlayers = [];
      const homePlayers = [];
      jiuBaState.playerIds.forEach(id => {
        const p = players.find(pl => pl.id === id);
        if (!p) return;
        if (jiuBaState.choices[id] === 'bar') {
          barPlayers.push(p);
        } else {
          homePlayers.push(p);
        }
      });
      const halfCount = Math.floor(jiuBaState.totalPlayers / 2);
      if (barPlayers.length <= halfCount) {
        barPlayers.forEach(p => {
          previewMoney(p.id, 35);
        });
      }
      homePlayers.forEach(p => {
        previewMoney(p.id, 5);
      });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      if (barPlayers.length <= halfCount) {
        const barNames = barPlayers.map(p => coloredName(p.name, p.color)).join('，');
        const homeNames = homePlayers.map(p => coloredName(p.name, p.color)).join('，');
        const parts = [];
        if (barPlayers.length > 0) parts.push(barNames + '+35');
        if (homePlayers.length > 0) parts.push(homeNames + '+5');
        io.emit('updateAreaE', { message: parts.join('；') });
      } else {
        if (homePlayers.length > 0) {
          const homeNames = homePlayers.map(p => coloredName(p.name, p.color)).join('，');
          io.emit('updateAreaE', { message: `酒吧人数过多，${homeNames}+5` });
        } else {
          io.emit('updateAreaE', { message: '酒吧人数过多' });
        }
      }
      io.emit('jiubaEnd');
      const current = players[currentPlayerIndex];
      if (current) {
        const s = io.sockets.sockets.get(current.id);
        if (s) s.emit('showEndTurn');
      }
      jiuBaState = null;
    }
  });

  socket.on('yinyueDiceSelect', ({ dice }) => {
    if (!yinyueState) return;
    if (socket.id !== yinyueState.commanderId) return;
    const targetId = yinyueState.playerOrder[yinyueState.currentIndex];
    yinyueState.diceMap[targetId] = dice;

    yinyueState.currentIndex += 1;
    if (yinyueState.currentIndex >= yinyueState.playerOrder.length) {
      const commanderName = players.find(p => p.id === yinyueState.commanderId)?.name || '他人';
      Object.entries(yinyueState.diceMap).forEach(([id, d]) => {
        if (!playerDiceRange[id]) playerDiceRange[id] = { min: 1, max: 6 };
        playerDiceRange[id].min = d;
        playerDiceRange[id].max = d;
        const targetPlayer = players.find(p => p.id === id);
        if (targetPlayer) {
          targetPlayer.yinyueDice = d;
          targetPlayer.yinyueBy = commanderName;
        }
      });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: '已完成音乐指挥' });
      io.emit('yinyueEnd');
      const current = players[currentPlayerIndex];
      if (current) {
        const s = io.sockets.sockets.get(current.id);
        if (s) s.emit('showEndTurn');
      }
      yinyueState = null;
    } else {
      const nextPlayer = players.find(p => p.id === yinyueState.playerOrder[yinyueState.currentIndex]);
      if (nextPlayer) {
        io.emit('updateAreaE', { message: `音乐指挥：请指定${coloredName(nextPlayer.name, nextPlayer.color)}的点数` });
        const s = io.sockets.sockets.get(yinyueState.commanderId);
        if (s) s.emit('yinyueDiceChoice');
      }
    }
  });

  socket.on('gongtongSelect', ({ choice }) => {
    if (!gongtongState) return;
    if (!gongtongState.playerIds.includes(socket.id)) return;
    if (gongtongState.choices[socket.id] !== undefined) return;
    gongtongState.choices[socket.id] = choice;

    if (Object.keys(gongtongState.choices).length === gongtongState.playerIds.length) {
      gongtongState.playerIds.forEach(id => {
        if (gongtongState.choices[id] === 'minus1') {
          const myProps = board.filter(s => s.isProperty && s.owner === id);
          if (myProps.length > 0) {
            const cheapest = myProps.reduce((min, s) => s.price < min.price ? s : min, myProps[0]);
            withPropertyProtection(id, () => {
              cheapest.owner = null;
              cheapest.houseLevel = 0;
            });
          }
        }
      });
      const current = players.find(p => p.id === gongtongState.currentPlayerId);
      const results = [];
      let sameCount = 0;
      gongtongState.playerIds.forEach(id => {
        const p = players.find(pl => pl.id === id);
        if (!p) return;
        const propCount = board.filter(s => s.isProperty && s.owner === id).length;
        if (propCount === gongtongState.myPropCount) {
          sameCount++;
          previewMoney(p.id, 20);
          results.push(coloredName(p.name, p.color) + '+20');
        } else {
          previewMoney(p.id, -30);
          results.push(coloredName(p.name, p.color) + '-30');
        }
      });
      if (sameCount > 0 && current) {
        const bonus = sameCount * 20;
        previewMoney(current.id, bonus);
        results.unshift(coloredName(current.name, current.color) + '+' + bonus);
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: results.join('，') });
      io.emit('gongtongEnd');
      if (current) {
        const s = io.sockets.sockets.get(current.id);
        if (s) s.emit('showEndTurn');
      }
      gongtongState = null;
    }
  });

  socket.on('yihuaSelectSource', ({ propertyId }) => {
    if (!yihuaState || yihuaState.phase !== 'selectSource') return;
    if (socket.id !== yihuaState.commanderId) return;
    const prop = board.find(s => s.id === propertyId);
    if (!prop || !prop.isProperty || prop.owner === socket.id || prop.houseLevel <= 0) return;
    yihuaState.sourceId = propertyId;
    yihuaState.phase = 'selectTarget';
    io.emit('updateAreaE', { message: '移动到哪里？' });
    const s = io.sockets.sockets.get(yihuaState.commanderId);
    if (s) s.emit('yihuaSelectTarget', { sourceName: prop.name });
  });

  socket.on('yihuaSelectTarget', ({ propertyId }) => {
    if (!yihuaState || yihuaState.phase !== 'selectTarget') return;
    if (socket.id !== yihuaState.commanderId) return;
    const targetProp = board.find(s => s.id === propertyId);
    if (!targetProp || !targetProp.isProperty || targetProp.owner !== socket.id) return;
    const sourceProp = board.find(s => s.id === yihuaState.sourceId);
    if (!sourceProp) return;

    const sourceOwnerId = sourceProp.owner;
    const doYihua = (finalTarget, hiddenMsg) => {
      targetProp.houseLevel += sourceProp.houseLevel;
      if (targetProp.houseLevel > 4) targetProp.houseLevel = 4;
      const sourceName = sourceProp.name;
      const targetName = targetProp.name;
      sourceProp.houseLevel = 0;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}将${sourceName}的房屋移动到${targetName}` });
      io.emit('yihuaEnd');
      const current = players[currentPlayerIndex];
      if (current) {
        const s = io.sockets.sockets.get(current.id);
        if (s) s.emit('showEndTurn');
      }
      yihuaState = null;
    };

    withHiddenCheck(socket.id, sourceOwnerId, doYihua, () => { socket.emit('showEndTurn'); yihuaState = null; }, (source) => { doYihua(source, '反弹，'); });
  });

  socket.on('hebaoSelectRow', ({ row }) => {
    if (!hebaoState) return;
    if (socket.id !== hebaoState.commanderId) return;
    const rowMap = {
      1: [3, 4, 5],
      2: [8, 9, 10],
      3: [13, 15, 16, 17],
      4: [21, 22, 23],
      5: [27, 28, 29],
      6: [31, 33, 34, 35]
    };
    const ids = rowMap[row];
    if (!ids) return;
    ids.forEach(id => {
      const prop = board.find(s => s.id === id);
      if (prop && prop.isProperty) {
        prop.owner = null;
        prop.houseLevel = 0;
      }
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `第${row}排已核爆炸` });
    io.emit('hebaoEnd');
    const current = players[currentPlayerIndex];
    if (current) {
      const s = io.sockets.sockets.get(current.id);
      if (s) s.emit('showEndTurn');
    }
    hebaoState = null;
  });

  socket.on('huanranSelectRow', ({ row }) => {
    if (!huanranState) return;
    if (socket.id !== huanranState.commanderId) return;
    const rowMap = {
      1: [3, 4, 5],
      2: [8, 9, 10],
      3: [13, 15, 16, 17],
      4: [21, 22, 23],
      5: [27, 28, 29],
      6: [31, 33, 34, 35]
    };
    const ids = rowMap[row];
    if (!ids) return;
    const upgraded = [];
    ids.forEach(id => {
      const prop = board.find(s => s.id === id);
      if (prop && prop.isProperty && prop.owner && prop.houseLevel < 4) {
        prop.houseLevel += 1;
        upgraded.push(prop.name);
      }
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `焕然一新，第${row}排房屋升级（${upgraded.join('，')}）` });
    io.emit('huanranEnd');
    const current = players[currentPlayerIndex];
    if (current) {
      const s = io.sockets.sockets.get(current.id);
      if (s) s.emit('showEndTurn');
    }
    huanranState = null;
  });

  socket.on('shengdongProtect', ({ propId }) => {
    if (!shengdongState || socket.id !== shengdongState.targetId) return;
    const prop = board.find(s => s.id === propId);
    if (!prop || !prop.isProperty || prop.owner !== shengdongState.targetId) return;
    shengdongState.protected = propId;
    const s = io.sockets.sockets.get(shengdongState.targetId);
    if (s) s.emit('shengdongProtectDone', { propName: prop.name });
    checkShengdongResolve();
  });

  function checkShengdongResolve() {
    if (!shengdongState || shengdongState.declared === null || shengdongState.attacked === null || shengdongState.protected === null) return;
    const current = players[currentPlayerIndex];
    const target = players.find(p => p.id === shengdongState.targetId);
    const declaredProp = board.find(s => s.id === shengdongState.declared);
    const attackedProp = board.find(s => s.id === shengdongState.attacked);
    const protectedProp = board.find(s => s.id === shengdongState.protected);
    if (!current || !target || !declaredProp || !attackedProp || !protectedProp) return;
    io.emit('shengdongEnd');
    const doEnd = () => {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      const s = io.sockets.sockets.get(current.id);
      if (s) s.emit('showEndTurn');
      shengdongState = null;
    };
    if (shengdongState.attacked === shengdongState.protected) {
      io.emit('updateAreaE', { message: `进攻${attackedProp.name}，保护${protectedProp.name}，安然无恙` });
      doEnd();
    } else if (shengdongState.declared === shengdongState.protected) {
      if (declaredProp.houseLevel > 0) declaredProp.houseLevel -= 1;
      withPropertyProtection(target.id, () => { attackedProp.owner = current.id; });
      const msg = `进攻${attackedProp.name}，声明和保护${declaredProp.name}，${declaredProp.name}降级，${coloredName(current.name, current.color)}获得${attackedProp.name}`;
      io.emit('updateAreaE', { message: msg });
      doEnd();
    } else {
      withPropertyProtection(target.id, () => {
        declaredProp.owner = null;
        declaredProp.houseLevel = 0;
      });
      withPropertyProtection(target.id, () => { attackedProp.owner = current.id; });
      const msg = `声明${declaredProp.name}，进攻${attackedProp.name}，保护${protectedProp.name}，失去${declaredProp.name}，${coloredName(current.name, current.color)}获得${attackedProp.name}`;
      const checkTarget = () => {
        doEnd();
      };
      checkTarget();
    }
  }

  socket.on('saidaoSelect', ({ number }) => {
    if (!saidaoState) return;
    if (!saidaoState.playerIds.includes(socket.id)) return;
    if (saidaoState.choices[socket.id] !== undefined) return;
    saidaoState.choices[socket.id] = number;
    const s = io.sockets.sockets.get(socket.id);
    if (s) s.emit('saidaoSelected');
    if (Object.keys(saidaoState.choices).length === saidaoState.playerIds.length) {
      const choices = saidaoState.choices;
      const numberCounts = {};
      Object.values(choices).forEach(n => {
        numberCounts[n] = (numberCounts[n] || 0) + 1;
      });
      const duplicateNumbers = new Set();
      Object.entries(numberCounts).forEach(([n, count]) => {
        if (count > 1) duplicateNumbers.add(parseInt(n));
      });
      let maxUniqueNumber = -1;
      let maxUniquePlayer = null;
      Object.entries(choices).forEach(([playerId, n]) => {
        if (!duplicateNumbers.has(n) && n > maxUniqueNumber) {
          maxUniqueNumber = n;
          maxUniquePlayer = playerId;
        }
      });
      const minus20Players = [];
      duplicateNumbers.forEach(n => {
        Object.entries(choices).forEach(([playerId, num]) => {
          if (num === n) {
            const p = players.find(pl => pl.id === playerId);
            if (p) {
              previewMoney(p.id, -20);
              minus20Players.push(p);
            }
          }
        });
      });
      if (maxUniquePlayer) {
        const winner = players.find(p => p.id === maxUniquePlayer);
        if (winner) {
          previewMoney(winner.id, 50);
        }
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      const groupedParts = [];
      const numberGroups = {};
      Object.entries(choices).forEach(([playerId, n]) => {
        if (!numberGroups[n]) numberGroups[n] = [];
        numberGroups[n].push(playerId);
      });
      Object.entries(numberGroups).sort((a, b) => parseInt(b[0]) - parseInt(a[0])).forEach(([n, pids]) => {
        const num = parseInt(n);
        const names = pids.map(pid => {
          const p = players.find(pl => pl.id === pid);
          return p ? coloredName(p.name, p.color) : '';
        }).filter(Boolean).join(',');
        const isDup = duplicateNumbers.has(num);
        const isWinner = pids.length === 1 && pids[0] === maxUniquePlayer;
        if (isWinner) {
          groupedParts.push(`${names}${num}+50`);
        } else if (isDup) {
          groupedParts.push(`${names}${num}-20`);
        } else {
          groupedParts.push(`${names}${num}`);
        }
      });
      io.emit('updateAreaE', { message: groupedParts.join('，') });
      const current = players[currentPlayerIndex];
      if (current) {
        const s = io.sockets.sockets.get(current.id);
        if (s) s.emit('showEndTurn');
      }
      saidaoState = null;
    }
  });

  socket.on('lihunConfirm', ({ row1PropIds, row2PropIds }) => {
    if (!lihunState) return;
    if (socket.id !== lihunState.targetId) return;
    lihunState.row1PropIds = row1PropIds;
    lihunState.row2PropIds = row2PropIds;
    const current = players[currentPlayerIndex];
    io.emit('lihunTargetConfirmed', { row1PropIds, row2PropIds });
    io.emit('updateAreaE', { message: `已分成2份，${coloredName(current.name, current.color)}请选择一份` });
    const s = io.sockets.sockets.get(lihunState.commanderId);
    if (s) s.emit('lihunChooseRow', { row1PropIds, row2PropIds });
  });

  socket.on('lihunSelectRow', ({ selectedRow }) => {
    if (!lihunState) return;
    if (socket.id !== lihunState.commanderId) return;
    const current = players[currentPlayerIndex];
    const target = players.find(p => p.id === lihunState.targetId);
    if (!current || !target) return;
    const myPropIds = selectedRow === 1 ? lihunState.row1PropIds : lihunState.row2PropIds;
    const otherPropIds = selectedRow === 1 ? lihunState.row2PropIds : lihunState.row1PropIds;
    const myNames = [];
    const otherNames = [];
    const currentLost = myPropIds.some(id => { const s = board.find(b => b.id === id); return s && s.owner === target.id; });
    const targetLost = otherPropIds.some(id => { const s = board.find(b => b.id === id); return s && s.owner === current.id; });
    myPropIds.forEach(id => {
      const prop = board.find(s => s.id === id);
      if (prop) {
        const loser = prop.owner === target.id ? target.id : (prop.owner === current.id ? current.id : null);
        if (loser) {
          withPropertyProtection(loser, () => { prop.owner = current.id; });
        } else {
          prop.owner = current.id;
        }
        myNames.push(prop.name);
      }
    });
    otherPropIds.forEach(id => {
      const prop = board.find(s => s.id === id);
      if (prop) {
        const loser = prop.owner === current.id ? current.id : (prop.owner === target.id ? target.id : null);
        if (loser) {
          withPropertyProtection(loser, () => { prop.owner = target.id; });
        } else {
          prop.owner = target.id;
        }
        otherNames.push(prop.name);
      }
    });
    const doEnd = () => {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('lihunEnd');
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}获得了${myNames.join('、')}，${coloredName(target.name, target.color)}获得了${otherNames.join('、')}` });
      socket.emit('showEndTurn');
      lihunState = null;
    };
    const checkTarget = () => {
      if (targetLost) {
        doEnd();
      } else {
        doEnd();
      }
    };
    if (currentLost) {
      checkTarget();
    } else {
      checkTarget();
    }
  });

  socket.on('qiutuSelectPlayer', ({ playerId }) => {
    if (!qiutuState) return;
    if (socket.id !== qiutuState.commanderId) return;
    const p = players.find(pl => pl.id === playerId);
    if (!p || p.bankrupt) return;
    if (qiutuState.selectedIds.includes(playerId)) return;

    const doAddPlayer = (finalTarget, hiddenMsg) => {
      if (qiutuState.selectedIds.includes(finalTarget.id)) return;
      qiutuState.selectedIds.push(finalTarget.id);
      if (qiutuState.selectedIds.length === 2) {
        io.emit('updateAreaE', { message: `${hiddenMsg}若都是合作各-5；都是背叛各-40；否则背叛的+30，合作的-50` });
        qiutuState.selectedIds.forEach(id => {
          const s = io.sockets.sockets.get(id);
          if (s) s.emit('qiutuChoice', { playerId: id });
        });
      }
    };

    withHiddenCheck(socket.id, playerId, doAddPlayer, () => { socket.emit('showEndTurn'); }, (source) => { doAddPlayer(source, '反弹，'); });
  });

  socket.on('qiutuSelect', ({ choice }) => {
    if (!qiutuState) return;
    if (!qiutuState.selectedIds.includes(socket.id)) return;
    if (qiutuState.choices[socket.id] !== undefined) return;
    qiutuState.choices[socket.id] = choice;
    const s = io.sockets.sockets.get(socket.id);
    if (s) s.emit('qiutuSelected');
    if (Object.keys(qiutuState.choices).length === 2) {
      const [id1, id2] = qiutuState.selectedIds;
      const p1 = players.find(p => p.id === id1);
      const p2 = players.find(p => p.id === id2);
      if (!p1 || !p2) return;
      const c1 = qiutuState.choices[id1];
      const c2 = qiutuState.choices[id2];
      if (c1 === 'cooperate' && c2 === 'cooperate') {
        previewMoney(p1.id, -5);
        previewMoney(p2.id, -5);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(p1.name, p1.color)}和${coloredName(p2.name, p2.color)}合作，各-5` });
      } else if (c1 === 'betray' && c2 === 'betray') {
        previewMoney(p1.id, -40);
        previewMoney(p2.id, -40);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(p1.name, p1.color)}和${coloredName(p2.name, p2.color)}互相背叛，各-40` });
      } else {
        const betrayer = c1 === 'betray' ? p1 : p2;
        const cooperator = c1 === 'cooperate' ? p1 : p2;
        previewMoney(cooperator.id, -50);
        previewMoney(betrayer.id, 30);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(cooperator.name, cooperator.color)}合作-50，${coloredName(betrayer.name, betrayer.color)}背叛+30` });
      }
      const current = players[currentPlayerIndex];
      if (current) {
        const s = io.sockets.sockets.get(current.id);
        if (s) s.emit('showEndTurn');
      }
      qiutuState = null;
    }
  });

  socket.on('kanuSelectCards', ({ cardIds }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!cardIds || cardIds.length !== 4) return;
    if (!current.cards) current.cards = [];
    cardIds.forEach(id => {
      const card = cardData.find(c => c.id === id);
      if (card) addCardToPlayer(current, card);
    });
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: '卡奴：获得4张卡' });
    socket.emit('kanuEnd');
    socket.emit('showEndTurn');
  });

  socket.on('jidiChoice', ({ action, target }) => {
    if (!jidiState) return;
    const current = players.find(p => p.id === socket.id);
    if (!current) return;
    if (!jidiState.aliveIds.includes(socket.id)) return;
    if (jidiState.choices[socket.id] !== null) return;
    if (action === 'shoot') {
      if (!target || target === socket.id) return;
      if (!jidiState.aliveIds.includes(target)) return;
      jidiState.choices[socket.id] = { action: 'shoot', target };
    } else if (action === 'rebound' || action === 'empty') {
      jidiState.choices[socket.id] = { action };
    } else {
      return;
    }
    io.emit('jidiChoiceMade', { playerId: socket.id });
    const allChosen = jidiState.aliveIds.every(id => jidiState.choices[id] !== null);
    if (allChosen) {
      resolveJidi();
    }
  });

  socket.on('chuangGuanContinue', () => {
    if (!chuangGuanState) return;
    const current = players.find(p => p.id === socket.id);
    if (!current || current.id !== chuangGuanState.playerId) return;
    chuangGuanState.bonus *= 2;
    chuangGuanState.successRate -= 1;
    const roll = Math.floor(Math.random() * 10) + 1;
    if (roll > chuangGuanState.successRate) {
      io.emit('chuangGuanResult', { playerId: chuangGuanState.playerId, roll, bonus: chuangGuanState.bonus, successRate: chuangGuanState.successRate, failed: true });
      chuangGuanState = null;
    } else {
      io.emit('chuangGuanResult', { playerId: chuangGuanState.playerId, roll, bonus: chuangGuanState.bonus, successRate: chuangGuanState.successRate, failed: false });
    }
  });

  socket.on('chuangGuanCollect', () => {
    if (!chuangGuanState) return;
    const current = players.find(p => p.id === socket.id);
    if (!current || current.id !== chuangGuanState.playerId) return;
    const bonus = chuangGuanState.bonus;
    const p = players.find(pp => pp.id === chuangGuanState.playerId);
    if (p) {
      previewMoney(p.id, bonus);
    }
    const playerInfo = { id: chuangGuanState.playerId, name: p ? p.name : '', color: p ? p.color : '#fff' };
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
    io.emit('chuangGuanCollect', { playerInfo, bonus });
    chuangGuanState = null;
  });

  socket.on('gaichaoSelect', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!targetId || targetId === socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;

    const doGaichao = (finalTarget, hiddenMsg) => {
      if (finalTarget.id === current.id) {
        io.emit('updateAreaE', { message: `${hiddenMsg}改朝换代取消` });
        socket.emit('showEndTurn');
        return;
      }
      const myProps = board.filter(s => s.isProperty && s.owner === current.id);
      const targetProps = board.filter(s => s.isProperty && s.owner === finalTarget.id);
      const currentLost = myProps.length > 0;
      const targetLost = targetProps.length > 0;
      myProps.forEach(s => {
        withPropertyProtection(current.id, () => { s.owner = finalTarget.id; });
      });
      targetProps.forEach(s => {
        withPropertyProtection(finalTarget.id, () => { s.owner = current.id; });
      });
      const currentName = coloredName(current.name, current.color);
      const targetName = coloredName(finalTarget.name, finalTarget.color);
      const doEnd = () => {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        io.emit('gaichaoResult', { playerInfo: { id: current.id, name: current.name, color: current.color }, targetInfo: { id: finalTarget.id, name: finalTarget.name, color: finalTarget.color } });
      };
      const checkTarget = () => {
        if (targetLost) {
          doEnd();
        } else {
          doEnd();
        }
      };
      if (currentLost) {
        checkTarget();
      } else {
        checkTarget();
      }
    };

    withHiddenCheck(current.id, target.id, doGaichao, () => { socket.emit('showEndTurn'); }, (source) => { doGaichao(source, '反弹，'); });
  });

  socket.on('baijinSelect', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!targetId || targetId === socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;

    const doBaijin = (finalTarget, hiddenMsg) => {
      if (finalTarget.id === current.id) {
        io.emit('updateAreaE', { message: `${hiddenMsg}换钱取消` });
        socket.emit('showEndTurn');
        return;
      }
      const myMoney = current.money;
      const targetMoney = finalTarget.money;
      current.money = targetMoney;
      finalTarget.money = myMoney;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      io.emit('baijinResult', { playerInfo: { id: current.id, name: current.name, color: current.color }, targetInfo: { id: finalTarget.id, name: finalTarget.name, color: finalTarget.color } });
    };

    withHiddenCheck(current.id, target.id, doBaijin, () => { socket.emit('showEndTurn'); }, (source) => { doBaijin(source, '反弹，'); });
  });

  socket.on('renwoxingSelect', ({ spaceId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (spaceId < 0 || spaceId >= board.length) return;
    current.position = spaceId;
    if (!current.cards) current.cards = [];
    const chuansongCard = cardData.find(c => c.id === 15);
    if (chuansongCard) {
      for (let i = 0; i < 3; i++) addCardToPlayer(current, chuansongCard);
    }
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
    io.emit('renwoxingResult', { playerInfo: { id: current.id, name: current.name, color: current.color }, spaceName: board[spaceId].name });
  });

  socket.on('nongminConfirm', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!nongminState || nongminState.playerId !== current.id || nongminState.phase !== 'waiting') return;
    nongminState.phase = 'selectProps';
    io.emit('nongminSelectProps', { playerId: current.id, propCount: nongminState.propCount });
  });

  socket.on('nongminSelectPropsConfirm', ({ propIds }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!nongminState || nongminState.playerId !== current.id) return;
    if (!propIds) return;
    nongminState.selectedPropIds = propIds;
    nongminState.phase = 'selectTarget';
    io.emit('nongminSelectTarget', { playerId: current.id });
  });

  socket.on('nongminSelectTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!nongminState || nongminState.playerId !== current.id || nongminState.phase !== 'selectTarget') return;
    if (!targetId || targetId === current.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;

    const doNongmin = (finalTarget, hiddenMsg) => {
      if (finalTarget.id === current.id) {
        io.emit('updateAreaE', { message: `${hiddenMsg}农民卡交换取消` });
        nongminState = null;
        socket.emit('showEndTurn');
        return;
      }
      const myPropIds = nongminState.selectedPropIds;
      const targetProps = board.filter(s => s.isProperty && s.owner === finalTarget.id);
      const shuffled = targetProps.sort(() => Math.random() - 0.5);
      const targetPropIds = shuffled.slice(0, 3).map(s => s.id);
      const currentLost = myPropIds.length > 0;
      const targetLost = targetPropIds.length > 0;
      myPropIds.forEach(id => {
        const space = board.find(s => s.id === id);
        if (space) {
          withPropertyProtection(current.id, () => { space.owner = finalTarget.id; });
        }
      });
      targetPropIds.forEach(id => {
        const space = board.find(s => s.id === id);
        if (space) {
          withPropertyProtection(finalTarget.id, () => { space.owner = current.id; });
        }
      });
      const currentName = coloredName(current.name, current.color);
      const targetName = coloredName(finalTarget.name, finalTarget.color);
      const doEnd = () => {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        io.emit('nongminResult', { playerInfo: { id: current.id, name: current.name, color: current.color }, targetInfo: { id: finalTarget.id, name: finalTarget.name, color: finalTarget.color } });
        nongminState = null;
      };
      const checkTarget = () => {
        if (targetLost) {
          doEnd();
        } else {
          doEnd();
        }
      };
      if (currentLost) {
        checkTarget();
      } else {
        checkTarget();
      }
    };

    withHiddenCheck(current.id, target.id, doNongmin, () => { nongminState = null; socket.emit('showEndTurn'); }, (source) => { doNongmin(source, '反弹，'); });
  });

  socket.on('startTarget', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    previewMoney(current.id, 6);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}+6` });
    socket.emit('showEndTurn');
  });

  socket.on('startChoice', () => {
    socket.emit('startChoice');
  });

  socket.on('startLoan', ({ amount, interest, installment }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!current.loans) current.loans = [];
    current.loans.push({ amount, interest, installment, remaining: 3 });
    previewMoney(current.id, amount);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}贷款${amount}` });
    socket.emit('showEndTurn');
  });

  socket.on('airportBuild', (spaceId) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.id === spaceId);
    if (!space || space.name !== '机场') return;
    const buildCost = Math.round(space.price / 4);
    if (current.money >= buildCost) {
      previewMoney(current.id, -buildCost);
      space.houseLevel++;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的机场升级！` });
      socket.emit('airportBuilt', { spaceId });
      socket.emit('showEndTurn');
    }
  });

  socket.on('airportReform', (spaceId) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.id === spaceId);
    if (!space || space.owner !== current.id) return;
    socket.emit('airportReformPanel', { spaceId, spaceName: space.name, airportType: space.airportType || null });
  });

  socket.on('airportReformSelect', ({ spaceId, airportType, airportDesc }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.id === spaceId);
    if (!space || space.owner !== current.id) return;
    space.airportType = airportType;
    space.description = airportDesc;
    space.displayName = airportType;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}将机场改造为${airportType}！` });
    socket.emit('airportReformDone', { spaceId, airportType });
  });

  socket.on('airportEffect', (spaceId) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.id === spaceId);
    if (!space || !space.airportType) return;

    if (space.airportType === '轰炸机') {
      const bombCard = cardData.find(c => c.id === 14);
      if (bombCard && !current.cards) current.cards = [];
      if (bombCard) addCardToPlayer(current, bombCard);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}获得炸弹卡` });
    } else if (space.airportType === '度假机') {
      const roll = Math.floor(Math.random() * 6) + 1;
      const doDujiajiJudge = () => {
        const newRoll = Math.floor(Math.random() * 6) + 1;
        if (newRoll <= 2) {
          sendToIsland(current.id, () => {
            io.emit('updateAreaE', { message: `判定为${newRoll}，${coloredName(current.name, current.color)}飞往海南` });
          });
        } else if (newRoll <= 4) {
          applyRest(current.id, 1, `判定为${newRoll}，${coloredName(current.name, current.color)}休息1回合`, socket);
        } else {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `判定为${newRoll}，无事发生` });
        }
      };
      const originalResult = () => {
        if (roll <= 2) {
          sendToIsland(current.id, () => {
            io.emit('updateAreaE', { message: `判定为${roll}，${coloredName(current.name, current.color)}飞往海南` });
          });
        } else if (roll <= 4) {
          applyRest(current.id, 1, `判定为${roll}，${coloredName(current.name, current.color)}休息1回合`, socket);
        } else {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `判定为${roll}，无事发生` });
        }
      };
      if (checkKoiOrDuogongnengJudge(current.id, doDujiajiJudge, originalResult)) {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        let resultText = roll <= 2 ? '飞往海南' : (roll <= 4 ? '休息1回合' : '无事发生');
        io.emit('updateAreaE', { message: `判定为${roll}，${resultText}，是否重新判定？` });
        return;
      }
      if (roll <= 2) {
        sendToIsland(current.id, () => {
          io.emit('updateAreaE', { message: `判定为${roll}，${coloredName(current.name, current.color)}飞往海南` });
        });
      } else if (roll <= 4) {
        applyRest(current.id, 1, `判定为${roll}，${coloredName(current.name, current.color)}休息1回合`, socket);
      } else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `判定为${roll}，无事发生` });
      }
    } else if (space.airportType === '观光机') {
      const newPos = Math.floor(Math.random() * 36);
      current.position = newPos;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}被弹飞到${board[newPos].name}` });
    } else if (space.airportType === '客机') {
      airportState = {
        type: 'guest',
        playerId: current.id,
        spaceId: space.id,
        waiting: true
      };
      socket.emit('airportGuestPanel', { spaceId, spaceName: space.name });
      return;
    } else if (space.airportType === '间谍机') {
      const S = Math.floor(Math.random() * 6) + 1;
      airportState = {
        type: 'spy',
        playerId: current.id,
        spaceId: space.id,
        secretNumber: S,
        declaredNumber: null,
        waitingDeclaration: true,
        waitingResponses: {},
        responders: []
      };
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      socket.emit('airportSpyDeclaration', { secretNumber: S });
      return;
    }
  });

  socket.on('airportGuestSelect', ({ targetSpaceId }) => {
    if (!airportState || airportState.type !== 'guest' || airportState.playerId !== socket.id) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const targetSpace = board.find(s => s.id === targetSpaceId);
    current.position = targetSpaceId;
    airportState = null;
    
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}飞往${targetSpace ? targetSpace.name : '未知'}` });
    socket.emit('showEndTurn');
  });

  socket.on('airportSpyDeclare', ({ declaredNumber }) => {
    if (!airportState || airportState.type !== 'spy' || airportState.playerId !== socket.id) return;
    if (!airportState.waitingDeclaration) return;
    
    airportState.declaredNumber = declaredNumber;
    airportState.waitingDeclaration = false;
    
    const current = players.find(p => p.id === socket.id);
    const otherPlayers = players.filter(p => !p.bankrupt && p.id !== socket.id);
    airportState.waitingResponses = {};
    otherPlayers.forEach(p => {
      airportState.waitingResponses[p.id] = false;
    });
    airportState.responders = [];
    
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}声明的点数为${declaredNumber}，是否质疑？` });
    io.emit('airportSpyChallenge', { declaredNumber, challengerIds: otherPlayers.map(p => p.id) });
  });

  socket.on('airportSpyResponse', ({ response }) => {
    if (!airportState || airportState.type !== 'spy') return;
    if (airportState.waitingResponses[socket.id]) return;
    
    airportState.waitingResponses[socket.id] = true;
    airportState.responders.push({ playerId: socket.id, response });
    
    const allResponded = Object.values(airportState.waitingResponses).every(v => v);
    if (allResponded) {
      const challengers = airportState.responders.filter(r => r.response === 'challenge').map(r => r.playerId);
      const current = players.find(p => p.id === airportState.playerId);
      
      if (challengers.length === 0) {
        previewMoney(current.id, 9);
        airportState.moveSteps = airportState.declaredNumber;
        airportState.challengers = challengers;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `真实${airportState.secretNumber}声明${airportState.declaredNumber}，无人质疑，${coloredName(current.name, current.color)}+9` });
        io.emit('spyResult', { secretNumber: airportState.secretNumber, declaredNumber: airportState.declaredNumber, result: 'noChallenge', challengerNames: '', playerId: airportState.playerId });
      } else {
        const S = airportState.secretNumber;
        const K = airportState.declaredNumber;
        const challengerNames = challengers.map(id => {
          const p = players.find(pl => pl.id === id);
          return coloredName(p.name, p.color);
        }).join(',');
        
        if (K === S) {
          challengers.forEach(challengerId => {
            const challenger = players.find(p => p.id === challengerId);
            if (challenger) {
              previewMoney(challengerId, -6);
              previewMoney(current.id, 6);
            }
          });
          io.emit('updateAreaE', { message: `真实${S}声明${K}，质疑者${challengerNames}给${coloredName(current.name, current.color)}6` });
        } else {
          challengers.forEach(challengerId => {
            const challenger = players.find(p => p.id === challengerId);
            if (challenger) {
              previewMoney(current.id, -6);
              previewMoney(challengerId, 6);
            }
          });
          io.emit('updateAreaE', { message: `真实${S}声明${K}，${coloredName(current.name, current.color)}给质疑者${challengerNames}6` });
        }
        
        airportState.moveSteps = S;
        airportState.challengers = challengers;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('spyResult', { secretNumber: airportState.secretNumber, declaredNumber: airportState.declaredNumber, result: K === S ? 'correct' : 'wrong', challengerNames, playerId: airportState.playerId });
      }
    }
  });

  socket.on('spyClose', () => {
    if (!airportState || airportState.type !== 'spy' || airportState.playerId !== socket.id) return;
    const current = players.find(p => p.id === socket.id);
    if (!current) return;
    const moveSteps = airportState.moveSteps;
    const fromPos = current.position;
    const newPos = (fromPos + moveSteps) % 36;
    airportState = null;
    currentDiceValue = moveSteps;
    if (diceAnimState) diceAnimState = null;
    io.emit('closeSpyPanel');
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('diceResult', { playerId: current.id, fromPos, dice: moveSteps, newPos, teleport: false });
    diceAnimState = { playerId: current.id, fromPos, dice: moveSteps, newPos };
  });

  socket.on('wuyueMountainEffect', (spaceId) => {

    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const space = board.find(s => s.id === spaceId);
    if (!space) return;
    const mountainName = space.name;

      if (mountainName === '泰山') {
      const targetPos = current.position === 0 ? board.length - 3 : current.position - 3;
      io.emit('taishanBackward', { playerId: current.id, fromPos: current.position, toPos: targetPos });
      current.position = targetPos;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}后退3格` });
      } else if (mountainName === '嵩山') {
      const roll = Math.floor(Math.random() * 6) + 1;
      const doSongshanJudge = () => {
        const newRoll = Math.floor(Math.random() * 6) + 1;
        if (newRoll <= 4) {
          const freeCard = cardData.find(c => c.id === 5);
          if (freeCard) {
            if (!current.cards) current.cards = [];
            addCardToPlayer(current, freeCard);
            socket.emit('addCardToD', { cardImage: freeCard.image, cardName: freeCard.name });
          }
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `判定为${newRoll}，获得免休卡` });
        } else {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `判定为${newRoll}，一无所获` });
        }
      };
      const originalResult = () => {
        if (roll <= 4) {
          const freeCard = cardData.find(c => c.id === 5);
          if (freeCard) {
            if (!current.cards) current.cards = [];
            addCardToPlayer(current, freeCard);
            socket.emit('addCardToD', { cardImage: freeCard.image, cardName: freeCard.name });
          }
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `判定为${roll}，获得免休卡` });
        } else {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `判定为${roll}，一无所获` });
        }
      };
      if (checkKoiOrDuogongnengJudge(current.id, doSongshanJudge, originalResult)) {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `判定为${roll}，${roll <= 4 ? '获得免休卡' : '一无所获'}，是否重新判定？` });
        return;
      }
      if (roll <= 4) {
        const freeCard = cardData.find(c => c.id === 5);
        if (freeCard) {
          if (!current.cards) current.cards = [];
          addCardToPlayer(current, freeCard);
          socket.emit('addCardToD', { cardImage: freeCard.image, cardName: freeCard.name });
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `判定为${roll}，获得免休卡` });
      } else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `判定为${roll}，一无所获` });
      }
    } else if (mountainName === '恒山') {
      const freeCard = cardData.find(c => c.id === 5);
      if (freeCard) {
        if (!current.cards) current.cards = [];
        addCardToPlayer(current, freeCard);
        socket.emit('addCardToD', { cardImage: freeCard.image, cardName: freeCard.name });
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}获得免休卡` });
      } else if (mountainName === '衡山') {
      applyRest(current.id, 1, `${coloredName(current.name, current.color)}休息1回合`, null);
    } else if (mountainName === '华山') {
      const roll = Math.floor(Math.random() * 6) + 1;
      const others = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
      let totalCollected = 0;
      others.forEach(p => {
        const amount = Math.min(roll, p.money);
        previewMoney(p.id, -amount);
        totalCollected += amount;
      });
      previewMoney(current.id, totalCollected);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}收取每人$${roll}，共$${totalCollected}` });
    }
  });

  socket.on('pinqianSelect', (targetPlayerId) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    if (targetPlayerId === null) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}放弃拼钱` });
      socket.emit('showEndTurn');
      return;
    }
    
    const target = players.find(p => p.id === targetPlayerId);
    if (!target) return;
    
    const hiddenCard = target.cards?.find(c => c.hiddenType && ['quxiao', 'jianyuan', 'zhuanyi', 'fantan'].includes(c.hiddenType));
    
    if (hiddenCard) {
      checkHiddenCardTarget(target.id, current.id, (cancelled) => {
        if (cancelled) {
          const sourceSocket = io.sockets.sockets.get(current.id);
          if (sourceSocket) sourceSocket.emit('showEndTurn');
          pendingHiddenResult = null;
          return;
        }
        let finalTarget = target;
        let hiddenMsg = '';
        if (pendingHiddenResult && pendingHiddenResult.message) {
          hiddenMsg = pendingHiddenResult.message + '，';
        }
        if (pendingHiddenResult && pendingHiddenResult.newTargetId) {
          const newTarget = players.find(p => p.id === pendingHiddenResult.newTargetId);
          if (newTarget) finalTarget = newTarget;
        }
        if (pendingHiddenResult && pendingHiddenResult.type === 'fantan') {
          // 反弹：不改变拼钱对象，只标记rebound，结算时反转效果
          pinqianState = {
            currentPlayerId: current.id,
            targetPlayerId: target.id,
            currentPlayerName: current.name,
            targetPlayerName: target.name,
            currentNumber: 0,
            targetNumber: 0,
            currentConfirmed: false,
            targetConfirmed: false,
            resultType: 'pinqian',
            hiddenMsg: hiddenMsg || '',
            rebound: true
          };
          pendingHiddenResult = null;
          socket.emit('pinqianStart', { playerName: current.name, playerColor: current.color, targetName: target.name, targetColor: target.color, isCurrent: true });
          const targetSocket = io.sockets.sockets.get(target.id);
          if (targetSocket) targetSocket.emit('pinqianStart', { playerName: current.name, playerColor: current.color, targetName: target.name, targetColor: target.color, isCurrent: false });
          return;
        }
        pendingHiddenResult = null;
        startPinqian(current, finalTarget, hiddenMsg);
      });
      return;
    }
    
    startPinqian(current, target, '');
  });

  function startPinqian(current, target, hiddenMsg) {
    pinqianState = {
      currentPlayerId: current.id,
      targetPlayerId: target.id,
      currentPlayerName: current.name,
      targetPlayerName: target.name,
      currentNumber: 0,
      targetNumber: 0,
      currentConfirmed: false,
      targetConfirmed: false,
      resultType: 'pinqian',
      hiddenMsg: hiddenMsg || '',
      rebound: current.id === target.id
    };
    
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${hiddenMsg || ''}${coloredName(current.name, current.color)}与${coloredName(target.name, target.color)}拼钱` });
    socket.emit('pinqianStart', {
      playerName: current.name,
      playerColor: current.color,
      targetName: target.name,
      targetColor: target.color,
      isCurrent: true,
      qiongqi: false
    });
    
    const targetSocket = io.sockets.sockets.get(target.id);
    if (targetSocket) {
      targetSocket.emit('pinqianStart', {
        playerName: current.name,
        playerColor: current.color,
        targetName: target.name,
        targetColor: target.color,
        isCurrent: false,
        qiongqi: false
      });
    }
  }

  function startQiongqiPinqian(payer, owner, sock) {
    pinqianState = {
      currentPlayerId: payer.id,
      targetPlayerId: owner.id,
      currentPlayerName: payer.name,
      targetPlayerName: owner.name,
      currentNumber: 0,
      targetNumber: 0,
      currentConfirmed: false,
      targetConfirmed: false,
      resultType: 'qiongqi',
      hiddenMsg: '',
      rebound: false
    };

    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(payer.name, payer.color)}与地主${coloredName(owner.name, owner.color)}拼钱，若胜掠夺10%现金` });
    sock.emit('pinqianStart', {
      playerName: payer.name,
      playerColor: payer.color,
      targetName: owner.name,
      targetColor: owner.color,
      isCurrent: true,
      qiongqi: true
    });
    const ownerSocket = io.sockets.sockets.get(owner.id);
    if (ownerSocket) {
      ownerSocket.emit('pinqianStart', {
        playerName: payer.name,
        playerColor: payer.color,
        targetName: owner.name,
        targetColor: owner.color,
        isCurrent: false,
        qiongqi: true
      });
    }
  }

  function startQinglongPinqian(payer, owner, spacePos, sock) {
    const propertyName = board[spacePos]?.name || '地产';
    pinqianState = {
      currentPlayerId: payer.id,
      targetPlayerId: owner.id,
      currentPlayerName: payer.name,
      targetPlayerName: owner.name,
      currentNumber: 0,
      targetNumber: 0,
      currentConfirmed: false,
      targetConfirmed: false,
      resultType: 'qinglong',
      hiddenMsg: '',
      rebound: false,
      qinglongSpacePos: spacePos
    };

    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(payer.name, payer.color)}与地主${coloredName(owner.name, owner.color)}拼钱，胜获得${propertyName}` });
    sock.emit('pinqianStart', {
      playerName: payer.name,
      playerColor: payer.color,
      targetName: owner.name,
      targetColor: owner.color,
      isCurrent: true,
      qinglong: true,
      qinglongPropertyName: propertyName
    });
    const ownerSocket = io.sockets.sockets.get(owner.id);
    if (ownerSocket) {
      ownerSocket.emit('pinqianStart', {
        playerName: payer.name,
        playerColor: payer.color,
        targetName: owner.name,
        targetColor: owner.color,
        isCurrent: false,
        qinglong: true,
        qinglongPropertyName: propertyName
      });
    }
  }

  socket.on('pinqianAdd', (value) => {
    if (!pinqianState) return;
    
    if (pinqianState.currentPlayerId === socket.id) {
      pinqianState.currentNumber += value;
      const current = players.find(p => p.id === socket.id);
      if (current && current.money < pinqianState.currentNumber) {
        pinqianState.currentNumber = current.money;
      }
      socket.emit('pinqianUpdate', { number: pinqianState.currentNumber });
    } else if (pinqianState.targetPlayerId === socket.id) {
      pinqianState.targetNumber += value;
      const target = players.find(p => p.id === socket.id);
      if (target && target.money < pinqianState.targetNumber) {
        pinqianState.targetNumber = target.money;
      }
      socket.emit('pinqianUpdate', { number: pinqianState.targetNumber });
    }
  });

  socket.on('pinqianClear', () => {
    if (!pinqianState) return;
    
    if (pinqianState.currentPlayerId === socket.id) {
      pinqianState.currentNumber = 0;
      socket.emit('pinqianUpdate', { number: 0 });
    } else if (pinqianState.targetPlayerId === socket.id) {
      pinqianState.targetNumber = 0;
      socket.emit('pinqianUpdate', { number: 0 });
    }
  });

  socket.on('pinqianConfirmWithValue', (value) => {
    if (!pinqianState) return;
    
    const current = players.find(p => p.id === socket.id);
    if (!current) return;
    
    const numValue = parseInt(value) || 0;
    
    if (pinqianState.currentPlayerId === socket.id) {
      if (numValue <= 0) return;
      pinqianState.currentNumber = numValue;
      pinqianState.currentConfirmed = true;
      socket.emit('pinqianConfirmed');
    } else if (pinqianState.targetPlayerId === socket.id) {
      if (numValue <= 0) return;
      pinqianState.targetNumber = numValue;
      pinqianState.targetConfirmed = true;
      socket.emit('pinqianConfirmed');
    }
    
    if (pinqianState.currentConfirmed && pinqianState.targetConfirmed) {
      const currentP = players.find(p => p.id === pinqianState.currentPlayerId);
      const targetP = players.find(p => p.id === pinqianState.targetPlayerId);
      const isRebound = pinqianState.rebound;
      
      // 结算时才扣款并显示动画
      if (currentP) {
        previewMoney(currentP.id, -pinqianState.currentNumber);
      }
      if (targetP) {
        previewMoney(targetP.id, -pinqianState.targetNumber);
      }
      
      const { currentNumber, targetNumber, resultType } = pinqianState;
      let resultMsg = '';
      let winner = null;
      
      if (currentNumber > targetNumber) {
        winner = currentP; // A出价更高，A赢了
      } else if (targetNumber > currentNumber) {
        winner = targetP; // B出价更高，B赢了
      }

      if (resultType === 'diamondRob') {
        if (winner) {
          const loser = winner.id === currentP.id ? targetP : currentP;
          // 地主是targetP（holder），抢夺者是currentP
          if (winner.id === targetP.id) {
            // 地主获胜，进度不清零
            loser.hasDiamond = false;
            winner.hasDiamond = true;
            // 进度保持不变
          } else {
            // 抢夺者获胜，清零进度并更改地主
            if (loser) loser.hasDiamond = false;
            winner.hasDiamond = true;
            diamondHolder = winner.id;
            diamondProgress = 0;
            diamondProgressPlayerId = winner.id;
            diamondProgressPlayerColor = winner.color;
            io.emit('diamondProgressUpdate', { playerId: winner.id, playerColor: winner.color, progress: 0 });
          }
        }
        resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}，${coloredName(targetP.name, targetP.color)}-${targetNumber}，${winner ? winner.name + '获得钻石' : '平局'}`;
      } else if (resultType === 'qiangjie') {
        // 反弹时反转胜负
        let actualWinner = winner;
        if (isRebound && winner) {
          actualWinner = winner.id === currentP.id ? targetP : currentP;
        }
        if (actualWinner && actualWinner.id === pinqianState.currentPlayerId) {
          qiangjieState = { robberId: actualWinner.id };
          const robberSocket = io.sockets.sockets.get(actualWinner.id);
          if (robberSocket) {
            const loser = actualWinner.id === currentP.id ? targetP : currentP;
            io.emit('bAreaOverlay', { imageSrc: '/drawable/kapian/qiangjie.png' });
            robberSocket.emit('qiangjieResult', {
              win: true,
              targetName: loser.name,
              targetColor: loser.color,
              targetCards: loser.cards || [],
              targetId: loser.id
            });
          }
          resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}，${coloredName(targetP.name, targetP.color)}-${targetNumber}${isRebound ? '，反弹' : ''}，${actualWinner.name}抢劫成功`;
        } else if (actualWinner && actualWinner.id === pinqianState.targetPlayerId) {
          resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}，${coloredName(targetP.name, targetP.color)}-${targetNumber}${isRebound ? '，反弹' : ''}，抢劫失败`;
        } else {
          resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}，${coloredName(targetP.name, targetP.color)}-${targetNumber}，平局`;
        }
      } else if (resultType === 'heike') {
        const frozenAmount = pinqianState.heikeFrozenAmount || 0;
        if (winner && winner.id === pinqianState.currentPlayerId) {
          const loser = winner.id === currentP.id ? targetP : currentP;
          previewMoney(winner.id, frozenAmount);
          loser.frozen = 0;
          resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}，${coloredName(targetP.name, targetP.color)}-${targetNumber}，用黑客卡入侵成功，获得${coloredName(loser.name, loser.color)}冻结金${frozenAmount}`;
        } else if (winner && winner.id === pinqianState.targetPlayerId) {
          resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}，${coloredName(targetP.name, targetP.color)}-${targetNumber}，用黑客卡入侵失败`;
        } else {
          resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}，${coloredName(targetP.name, targetP.color)}-${targetNumber}，平局`;
        }
      } else if (resultType === 'zemuerqi') {
        if (winner) {
          const loser = winner.id === currentP.id ? targetP : currentP;
          if (loser.petImage) {
            if (!winner.petImage) {
              winner.petImage = loser.petImage;
            } else {
              if (!winner.extraPets) winner.extraPets = [];
              winner.extraPets.push(loser.petImage);
            }
            loser.petImage = null;
          }
          const winnerNum = winner.id === currentP.id ? currentNumber : targetNumber;
          const loserNum = winner.id === currentP.id ? targetNumber : currentNumber;
          resultMsg = `${coloredName(winner.name, winner.color)}-${winnerNum}获胜，获得${coloredName(loser.name, loser.color)}-${loserNum}的宠物`;
        } else {
          resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}，${coloredName(targetP.name, targetP.color)}-${targetNumber}，平局`;
        }
      } else if (resultType === 'diaohu') {
        previewMoney(currentP.id, targetNumber);
        const loser = winner ? (winner.id === currentP.id ? targetP : currentP) : null;
        const diaohuCurrentSocket = io.sockets.sockets.get(pinqianState.currentPlayerId);
        if (loser) {
          sendToIsland(loser.id, () => {
            let currentMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}+${targetNumber}`;
            let targetMsg = `${coloredName(targetP.name, targetP.color)}-${targetNumber}`;
            if (winner.id === currentP.id) {
              targetMsg += '到海南';
            } else {
              currentMsg += '到海南';
            }
            resultMsg = `${currentMsg}，${targetMsg}`;
            pinqianState = null;
            diaohuState = null;
            io.emit('updateAreaE', { message: resultMsg });
            if (diaohuCurrentSocket) diaohuCurrentSocket.emit('showEndTurn');
          });
          return;
        } else {
          let currentMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}+${targetNumber}`;
          let targetMsg = `${coloredName(targetP.name, targetP.color)}-${targetNumber}`;
          resultMsg = `${currentMsg}，${targetMsg}`;
          pinqianState = null;
          diaohuState = null;
          io.emit('updateAreaE', { message: resultMsg });
          if (diaohuCurrentSocket) diaohuCurrentSocket.emit('showEndTurn');
          return;
        }
      } else if (resultType === 'yuanjiao') {
        const targetA = players.find(p => p.id === yuanjiaoState.targetA);
        const targetB = players.find(p => p.id === yuanjiaoState.targetB);
        if (targetA && currentNumber > 0) {
          previewMoney(targetA.id, currentNumber);
        }
        let resultStr = '';
        if (winner) {
          if (winner.id === currentP.id) {
            previewMoney(targetB.id, -10);
            previewMoney(currentP.id, 10);
            resultStr = `${coloredName(currentP.name, currentP.color)}给${coloredName(targetA.name, targetA.color)}${currentNumber}，从${coloredName(targetB.name, targetB.color)}-${targetNumber}掠夺10`;
          } else {
            previewMoney(currentP.id, -10);
            previewMoney(targetB.id, 10);
            resultStr = `${coloredName(currentP.name, currentP.color)}给${coloredName(targetA.name, targetA.color)}${currentNumber}，被${coloredName(targetB.name, targetB.color)}-${targetNumber}掠夺10`;
          }
        } else {
          resultStr = `${coloredName(currentP.name, currentP.color)}给${coloredName(targetA.name, targetA.color)}${currentNumber}，${coloredName(targetB.name, targetB.color)}-${targetNumber}，平局`;
        }
        resultMsg = resultStr;
        yuanjiaoState = null;
      } else if (resultType === 'qiongqi') {
        // 穷奇：宠物拥有者（currentP/交路费者）获胜则掠夺地主10%现金，否则翻面
        if (winner && winner.id === pinqianState.currentPlayerId) {
          const stealAmount = Math.floor(targetP.money * 0.1);
          if (stealAmount > 0) {
            previewMoney(winner.id, stealAmount);
            previewMoney(targetP.id, -stealAmount);
          }
          resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}胜，掠夺10%现金${stealAmount}，${coloredName(targetP.name, targetP.color)}-${targetNumber}败`;
        } else {
          if (currentP) currentP.petFlipped = true;
          const isTie = !winner;
          const resultWord = isTie ? '平' : '败';
          const loserWord = isTie ? '平' : '胜';
          resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}${resultWord}，穷奇翻面，${coloredName(targetP.name, targetP.color)}-${targetNumber}${loserWord}`;
        }
      } else if (resultType === 'qinglong') {
        if (winner && winner.id === pinqianState.currentPlayerId) {
          const spacePos = pinqianState.qinglongSpacePos;
          if (spacePos !== undefined) {
            const property = board[spacePos];
      if (property && property.owner === pinqianState.targetPlayerId) {
        property.owner = pinqianState.currentPlayerId;
            }
          }
          resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}胜获得${board[spacePos]?.name || '地产'}，${coloredName(targetP.name, targetP.color)}-${targetNumber}败`;
        } else {
          const curP = players.find(p => p.id === pinqianState.currentPlayerId);
          if (curP) curP.petImage = null;
          const isTie = !winner;
          const resultWord = isTie ? '平' : '败';
          const loserWord = isTie ? '平' : '胜';
          resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}${resultWord}失去青龙，${coloredName(targetP.name, targetP.color)}-${targetNumber}${loserWord}`;
        }
      } else {
        if (isRebound) {
          // 反弹：对B的效果转移给A，对A的效果不变。输入的钱不参与反弹
          if (winner) {
            if (winner.id === currentP.id) {
              // A赢了：A+10（对A的效果不变），B的+10效果转移给A
              previewMoney(currentP.id, 10);
              resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}，${coloredName(targetP.name, targetP.color)}反弹，${coloredName(currentP.name, currentP.color)}胜+10`;
            } else {
              // B赢了：对B的+10效果转移给A
              previewMoney(currentP.id, 10);
              resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}，${coloredName(targetP.name, targetP.color)}反弹，${coloredName(currentP.name, currentP.color)}获得反弹+10`;
            }
          } else {
            resultMsg = `${coloredName(currentP.name, currentP.color)}-${currentNumber}，${coloredName(targetP.name, targetP.color)}反弹，平局`;
          }
        } else {
          if (winner) {
            previewMoney(winner.id, 10);
          }
          const loser = winner ? (winner.id === currentP.id ? targetP : currentP) : null;
          resultMsg = winner
            ? `${coloredName(winner.name, winner.color)}-${winner.id === currentP.id ? currentNumber : targetNumber}胜+10，${coloredName(loser.name, loser.color)}-${loser.id === currentP.id ? currentNumber : targetNumber}`
            : `${coloredName(currentP.name, currentP.color)}-${currentNumber}，${coloredName(targetP.name, targetP.color)}-${targetNumber}，平局`;
        }
      }
      const pinqianHiddenMsg = pinqianState.hiddenMsg || '';
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: pinqianHiddenMsg + resultMsg });
      if (resultType !== 'qiangjie' || !qiangjieState) {
        const currentSocket = io.sockets.sockets.get(pinqianState.currentPlayerId);
        if (currentSocket) currentSocket.emit('showEndTurn');
      }
      pinqianState = null;
    }
  });

  socket.on('guashaSelect', ({ targetId }) => {
    if (!guashaState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.money <= 50) return;
    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      if (finalTarget.bankrupt || finalTarget.money <= 50) {
        guashaState = null;
        socket.emit('showEndTurn');
        return;
      }
      previewMoney(finalTarget.id, -7);
      guashaState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}令${coloredName(finalTarget.name, finalTarget.color)}-7` });
      socket.emit('showEndTurn');
    }, () => {
      guashaState = null;
      socket.emit('showEndTurn');
    });
  });

  socket.on('jiaoyiSelectTarget', ({ targetId }) => {
    if (!jiaoyiState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;
    const targetProps = board.filter(s => s.isProperty && s.owner === target.id);
    if (targetProps.length === 0) return;
    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      const finalTargetProps = board.filter(s => s.isProperty && s.owner === finalTarget.id);
      if (finalTargetProps.length === 0) {
        jiaoyiState = null;
        socket.emit('showEndTurn');
        return;
      }
      jiaoyiState = { currentId: current.id, targetId: finalTarget.id, currentPropId: null, targetPropId: null };
      io.emit('jiaoyiSelectProps', { currentId: current.id, targetId: finalTarget.id, currentName: current.name, currentColor: current.color, targetName: finalTarget.name, targetColor: finalTarget.color });
    }, () => {
      jiaoyiState = null;
      socket.emit('showEndTurn');
    });
  });

  socket.on('jiaoyiPropSelected', ({ propId, ownerId }) => {
    if (!jiaoyiState) return;
    const current = players[currentPlayerIndex];
    if (!current) return;
    if (socket.id !== jiaoyiState.currentId && socket.id !== jiaoyiState.targetId) return;
    if (socket.id === jiaoyiState.currentId && ownerId !== jiaoyiState.currentId) return;
    if (socket.id === jiaoyiState.targetId && ownerId !== jiaoyiState.targetId) return;
    if (ownerId === jiaoyiState.currentId) {
      jiaoyiState.currentPropId = propId;
    } else if (ownerId === jiaoyiState.targetId) {
      jiaoyiState.targetPropId = propId;
    }
    io.emit('jiaoyiPropUpdate', { currentPropId: jiaoyiState.currentPropId, targetPropId: jiaoyiState.targetPropId });
    if (jiaoyiState.currentPropId && jiaoyiState.targetPropId) {
      const curProp = board.find(s => s.id === jiaoyiState.currentPropId);
      const tgtProp = board.find(s => s.id === jiaoyiState.targetPropId);
      if (curProp && tgtProp) {
        const tmpOwner = curProp.owner;
        curProp.owner = tgtProp.owner;
        tgtProp.owner = tmpOwner;
      }
      const curPlayer = players.find(p => p.id === jiaoyiState.currentId);
      const tgtPlayer = players.find(p => p.id === jiaoyiState.targetId);
      jiaoyiState = null;
      io.emit('jiaoyiEnd');
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(curPlayer.name, curPlayer.color)}的${curProp.name}与${coloredName(tgtPlayer.name, tgtPlayer.color)}的${tgtProp.name}互换` });
      const currentSocket = io.sockets.sockets.get(current.id);
      if (currentSocket) currentSocket.emit('showEndTurn');
    }
  });

  socket.on('zemuerqiSelectTarget', ({ targetId }) => {
    if (!zemuerqiState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || !target.petImage) return;
    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      if (!finalTarget.petImage) {
        zemuerqiState = null;
        socket.emit('showEndTurn');
        return;
      }
      zemuerqiState = null;
      pinqianState = {
        currentPlayerId: current.id,
        targetPlayerId: finalTarget.id,
        currentNumber: 0,
        targetNumber: 0,
        currentConfirmed: false,
        targetConfirmed: false,
        resultType: 'zemuerqi',
        hiddenMsg: hiddenMsg
      };
      const currentSocket = io.sockets.sockets.get(current.id);
      const targetSocket = io.sockets.sockets.get(finalTarget.id);
      if (currentSocket) {
        currentSocket.emit('pinqianStart', {
          playerName: current.name,
          playerColor: current.color,
          targetName: finalTarget.name,
          targetColor: finalTarget.color,
          isCurrent: true
        });
      }
      if (targetSocket) {
        targetSocket.emit('pinqianStart', {
          playerName: current.name,
          playerColor: current.color,
          targetName: finalTarget.name,
          targetColor: finalTarget.color,
          isCurrent: false
        });
      }
    }, () => {
      zemuerqiState = null;
      socket.emit('showEndTurn');
    });
  });

  socket.on('zibaoSelectProp', ({ propId }) => {
    if (!zibaoState) return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt) return;
    const prop = board.find(s => s.id === propId);
    if (!prop || !prop.isProperty || prop.owner !== socket.id) return;
    zibaoState.selections[socket.id] = propId;
    io.emit('zibaoPropSelected', { playerId: socket.id, propId: propId });
    const allSelected = Object.values(zibaoState.selections).every(v => v !== null);
    if (allSelected) {
      const messages = [];
      for (const [playerId, propId] of Object.entries(zibaoState.selections)) {
        const p = players.find(pl => pl.id === playerId);
        const pr = board.find(s => s.id === propId);
        if (p && pr) {
          pr.owner = null;
          pr.houses = 0;
          messages.push(`${coloredName(p.name, p.color)}失去${pr.name}`);
        }
      }
      zibaoState = null;
      io.emit('zibaoEnd');
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: messages.join('，') });
      const current = players[currentPlayerIndex];
      const currentSocket = io.sockets.sockets.get(current.id);
      if (currentSocket) currentSocket.emit('showEndTurn');
    }
  });

  socket.on('zibaoTriggered', () => {
    if (!zibaoState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    io.emit('zibaoSelectPropStart');
  });

  socket.on('jihuiChoice', ({ choice }) => {
    if (!jihuiState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    let amount = 0;
    if (choice === '7') {
      amount = 7;
    } else if (choice === 'random') {
      const dice = Math.floor(Math.random() * 6) + 1;
      amount = dice * 2;
    }
    previewMoney(current.id, amount);
    jihuiState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}+${amount}` });
    socket.emit('showEndTurn');
  });

  socket.on('nantiChoice', ({ choice }) => {
    if (!nantiState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    let amount = 0;
    if (choice === '7') {
      amount = 7;
    } else if (choice === 'random') {
      const dice = Math.floor(Math.random() * 6) + 1;
      amount = dice * 2;
    }
    previewMoney(current.id, -amount);
    nantiState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}-${amount}` });
    socket.emit('showEndTurn');
  });

  socket.on('shuiguojiPlay', () => {
    if (!shuiguojiState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (current.money < 18) {
      io.emit('updateAreaE', { message: '金钱不足18' });
      socket.emit('showEndTurn');
      shuiguojiState = null;
      return;
    }
    previewMoney(current.id, -18);
    const dice1 = Math.floor(Math.random() * 6) + 1;
    const dice2 = Math.floor(Math.random() * 6) + 1;
    const dice3 = Math.floor(Math.random() * 6) + 1;
    let amount = 0;
    if (dice1 === dice2 && dice2 === dice3) {
      amount = dice1 * 100;
    } else if (dice1 === dice2 || dice2 === dice3 || dice1 === dice3) {
      let sameDice, diffDice;
      if (dice1 === dice2) {
        sameDice = dice1;
        diffDice = dice3;
      } else if (dice2 === dice3) {
        sameDice = dice2;
        diffDice = dice1;
      } else {
        sameDice = dice1;
        diffDice = dice2;
      }
      amount = sameDice * 10 + diffDice;
    } else {
      amount = dice1 + dice2 + dice3;
    }
    previewMoney(current.id, amount);
    shuiguojiState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('shuiguojiResult', { playerId: current.id, dice1, dice2, dice3, amount });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}-18+${amount}` });
  });

  socket.on('shuiguojiClose', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    io.emit('shuiguojiPanelClose');
    socket.emit('showEndTurn');
  });

  socket.on('xitieshiSelectTarget', ({ targetId }) => {
    if (!xitieshiState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;
    const targetSpace = board.find(s => s.id === current.position);
    target.position = current.position;
    xitieshiState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}将${coloredName(target.name, target.color)}拉到${targetSpace ? targetSpace.name : current.position}` });
    socket.emit('showEndTurn');
  });

  socket.on('lijianSelectTarget', ({ targetId }) => {
    if (!lijianState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;
    
    if (!lijianState.targetA) {
      lijianState.targetA = targetId;
      io.emit('lijianSelectSecond', { playerId: current.id, firstTargetId: targetId });
    } else if (!lijianState.targetB && targetId !== lijianState.targetA) {
      lijianState.targetB = targetId;
      const targetA = players.find(p => p.id === lijianState.targetA);
      const targetB = players.find(p => p.id === lijianState.targetB);
      lijianState.currentTurn = lijianState.targetA;
      lijianState.eMsg = `${coloredName(targetA.name, targetA.color)}与${coloredName(targetB.name, targetB.color)}开始决斗，选择-10后结束决斗`;
      lijianState.lastPlayer = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('lijianDuelStart', { playerId: current.id, targetAId: lijianState.targetA, targetBId: lijianState.targetB, eMsg: lijianState.eMsg });
    }
  });

  socket.on('lijianChoice', ({ choice }) => {
    if (!lijianState) return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.id !== lijianState.currentTurn) return;
    
    const targetA = players.find(p => p.id === lijianState.targetA);
    const targetB = players.find(p => p.id === lijianState.targetB);
    const current = players[currentPlayerIndex];
    
    if (choice === '-1') {
      previewMoney(player.id, -1);
      lijianState.lastPlayer = { name: player.name, color: player.color };
      const baseMsg = `${coloredName(targetA.name, targetA.color)}与${coloredName(targetB.name, targetB.color)}开始决斗，选择-10后结束决斗`;
      lijianState.eMsg = `${baseMsg}（${coloredName(player.name, player.color)}-1）`;
      const nextTurn = lijianState.currentTurn === lijianState.targetA ? lijianState.targetB : lijianState.targetA;
      lijianState.currentTurn = nextTurn;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('lijianDuelContinue', { playerId: current.id, nextTurnId: nextTurn, eMsg: lijianState.eMsg });
    } else if (choice === '-10') {
      previewMoney(player.id, -10);
      lijianState.eMsg = `${coloredName(player.name, player.color)}决斗失败-10`;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('lijianDuelEnd', { playerId: current.id, eMsg: lijianState.eMsg });
      lijianState = null;
    }
  });

  socket.on('wuzhongshengyouSelectProp', ({ propId }) => {
    if (!wuzhongshengyouState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const prop = board.find(s => s.id === propId);
    if (!prop || !prop.isProperty || prop.owner !== current.id) return;
    
    const bankEmptyProps = board.filter(s => s.isProperty && !s.owner);
    const shuffled = bankEmptyProps.sort(() => Math.random() - 0.5);
    const selectedBankProps = shuffled.slice(0, Math.min(2, shuffled.length));
    
    const gainedProps = selectedBankProps.filter(bp => bp.price < prop.price);
    const lostPropName = prop.name;
    const lostPropPrice = prop.price;
    const bankPropNames = selectedBankProps.map(bp => `${bp.name}${bp.price}`).join('，');
    
    prop.owner = null;
    prop.houseLevel = 0;
    gainedProps.forEach(bp => {
      bp.owner = current.id;
    });
    
    let resultMsg = `${coloredName(current.name, current.color)}失去${lostPropName}${lostPropPrice}，银行随机的地产是${bankPropNames}`;
    if (gainedProps.length > 0) {
      resultMsg += `，获得${gainedProps.map(bp => bp.name).join('、')}`;
    }
    
    wuzhongshengyouState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: resultMsg });
    socket.emit('showEndTurn');
  });

  socket.on('gongchengSelectTarget', ({ propId }) => {
    if (!gongchengState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const prop = board.find(s => s.id === propId);
    if (!prop || !prop.isProperty || prop.owner === current.id || prop.houseLevel <= 0) return;
    const target = players.find(p => p.id === prop.owner);
    if (!target || target.bankrupt) return;
    
    gongchengState.propId = propId;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    
    // 先检查自动保护状态
    if (checkProtectedAsset(target.id, 'property')) {
      gongchengState = null;
      io.emit('updateAreaE', { message: `${coloredName(target.name, target.color)}的保护卡生效，${prop.name}免于被攻城` });
      socket.emit('showEndTurn');
      return;
    }
    
    // 再检查手牌中的保护卡
    const hasProtectCard = target.cards && target.cards.some(c => c.name === '保护卡');
    if (hasProtectCard) {
      baohuQueryState = {
        propertyId: prop.id,
        ownerId: target.id,
        currentPlayerId: current.id,
        source: 'gongcheng',
        propName: prop.name,
        attackerName: current.name,
        attackerColor: current.color
      };
      const targetSocket = io.sockets.sockets.get(target.id);
      if (targetSocket) {
        targetSocket.emit('baohuQuery', { propertyName: prop.name, currentPlayerName: current.name, currentPlayerColor: current.color });
      }
      io.emit('baohuOverlay', { targetPlayerId: target.id, propertyName: prop.name, targetName: target.name, targetColor: target.color });
      return;
    }
    
    // 无保护卡，直接执行攻城
    gongchengState.targetId = target.id;
    io.emit('gongchengShowPanel', { 
      targetId: target.id, 
      propId, 
      propName: prop.name, 
      attackerName: current.name, 
      attackerColor: current.color 
    });
  });

  socket.on('gongchengShowMoney', ({ amount }) => {
    if (!gongchengState) return;
    const target = players.find(p => p.id === gongchengState.targetId);
    if (!target || target.id !== socket.id) return;
    const current = players[currentPlayerIndex];
    const prop = board.find(s => s.id === gongchengState.propId);
    
    const halfAmount = Math.floor(amount / 2);
    gongchengState.showAmount = amount;
    gongchengState.halfAmount = halfAmount;
    
    io.emit('gongchengAttackerChoose', { playerId: current.id, targetId: target.id, showAmount: amount, halfAmount, propName: prop.name });
  });

  socket.on('gongchengChoice', ({ choice }) => {
    if (!gongchengState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === gongchengState.targetId);
    const prop = board.find(s => s.id === gongchengState.propId);
    
    if (choice === 'downgrade') {
      if (current.money >= gongchengState.showAmount) {
        previewMoney(current.id, -gongchengState.showAmount);
        prop.houseLevel -= 1;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}花${gongchengState.showAmount}令${prop.name}降级` });
      }
    } else if (choice === 'half') {
      previewMoney(target.id, -gongchengState.halfAmount);
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}令${coloredName(target.name, target.color)}-${gongchengState.halfAmount}` });
    }
    
    gongchengState = null;
    socket.emit('showEndTurn');
  });

  socket.on('shenbingSelectTarget', ({ targetPos }) => {
    if (!shenbingState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const targetSpace = board.find(s => s.id === targetPos);
    if (!targetSpace) return;
    current.position = targetPos;
    shenbingState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}移动到${targetSpace.name}` });
    socket.emit('showEndTurn');
  });

  socket.on('banjiaSelectSource', ({ propId }) => {
    if (!banjiaState || banjiaState.step !== 'selectSource') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const prop = board.find(s => s.id === propId);
    if (!prop || !prop.isProperty || prop.owner !== current.id || prop.houseLevel === 0) return;
    banjiaState.sourcePropId = propId;
    banjiaState.step = 'selectTarget';
    io.emit('banjiaSelectTarget', { playerId: current.id, sourcePropId: propId });
  });

  socket.on('banjiaSelectTargetProp', ({ propId }) => {
    if (!banjiaState || banjiaState.step !== 'selectTarget') return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const targetProp = board.find(s => s.id === propId);
    if (!targetProp || !targetProp.isProperty || targetProp.owner !== current.id || propId === banjiaState.sourcePropId) return;
    const sourceProp = board.find(s => s.id === banjiaState.sourcePropId);
    if (!sourceProp) return;
    const housesToMove = sourceProp.houseLevel;
    sourceProp.houseLevel = 0;
    targetProp.houseLevel = Math.min(4, targetProp.houseLevel + housesToMove);
    banjiaState = null;
    io.emit('banjiaEnd');
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}把${sourceProp.name}的房屋搬到${targetProp.name}` });
    socket.emit('showEndTurn');
  });

  socket.on('hunshuiSelectTarget', ({ targetId }) => {
    if (!hunshuiState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || !target.cards || target.cards.length === 0) return;
    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      if (!finalTarget.cards || finalTarget.cards.length === 0) {
        hunshuiState = null;
        socket.emit('showEndTurn');
        return;
      }
      const success = Math.random() < 1/3;
      if (success) {
        const randomIndex = Math.floor(Math.random() * finalTarget.cards.length);
        const card = finalTarget.cards.splice(randomIndex, 1)[0];
        if (!current.cards) current.cards = [];
        current.cards.push(card);
        hunshuiState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}获得${coloredName(finalTarget.name, finalTarget.color)}的${card.name}` });
      } else {
        hunshuiState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}没抽中卡片` });
      }
      socket.emit('showEndTurn');
    }, () => {
      hunshuiState = null;
      socket.emit('showEndTurn');
    });
  });

  socket.on('zangkuanTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.sheltered || target.id === current.id) return;

    qiyuState = null;

    // 使用withHiddenCheck包装，处理隐藏卡触发
    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      const freezeAmount = Math.min(18, finalTarget.money);
      if (freezeAmount > 0) {
        previewMoney(finalTarget.id, -freezeAmount);
        finalTarget.frozen = (finalTarget.frozen || 0) + freezeAmount;
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}冻结${coloredName(finalTarget.name, finalTarget.color)}${freezeAmount}` });
      socket.emit('showEndTurn');
    }, () => {
      // 隐藏卡取消目标
      socket.emit('showEndTurn');
    }, (sourcePlayer) => {
      // 隐藏卡反弹
      const freezeAmount = Math.min(18, current.money);
      if (freezeAmount > 0) {
        previewMoney(current.id, -freezeAmount);
        current.frozen = (current.frozen || 0) + freezeAmount;
      }
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(target.name, target.color)}使用隐藏卡将赃款反弹给${coloredName(sourcePlayer.name, sourcePlayer.color)}，冻结${freezeAmount}` });
      socket.emit('showEndTurn');
    });
  });

  socket.on('xiaotouSelectCard', ({ targetId, cardIndex }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id || !target.cards || cardIndex < 0 || cardIndex >= target.cards.length) return;
    const card = target.cards.splice(cardIndex, 1)[0];
    if (!current.cards) current.cards = [];
    current.cards.push(card);
    previewMoney(current.id, -6);
    previewMoney(target.id, 6);
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}给${coloredName(target.name, target.color)}6获得他的${card.name}` });
    socket.emit('showEndTurn');
  });

  socket.on('qianbianSelectCard', ({ targetId, cardIndex }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = targetId ? players.find(p => p.id === targetId) : current;
    if (!target || target.bankrupt || !target.cards || cardIndex < 0 || cardIndex >= target.cards.length) return;
    const oldCard = target.cards[cardIndex];
    const oldName = oldCard.name;
    const newCard = getRandomCard();
    target.cards[cardIndex] = { ...newCard };
    qiyuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}将${coloredName(target.name, target.color)}的${oldName}转换为${newCard.name}` });
    socket.emit('showEndTurn');
  });

  socket.on('jiyuCardResponse', ({ action }) => {
    if (!jiyuPendingState || jiyuPendingState.playerId !== socket.id) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const pendingJiyu = jiyuPendingState.jiyu;
    jiyuPendingState = null;

    if (action === 'koi') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}使用锦鲤重新抽机遇` });
      const newJiyu = weightedRandomJiyu();
      processJiyuCard(socket, current, newJiyu);
      return;
    }

    if (action === 'redraw') {
      // 消耗多功能卡，重新抽机遇，直接执行新机遇
      const idx = current.cards.findIndex(c => c.name === '多功能卡');
      if (idx !== -1) {
        current.cards.splice(idx, 1);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      }
      const newJiyu = weightedRandomJiyu();
      processJiyuCard(socket, current, newJiyu);
      return;
    }

    if (action === 'skip') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${pendingJiyu.name}:${pendingJiyu.desc}（不使用）` });
      socket.emit('showEndTurn');
      return;
    }

    // action === 'use'，执行机遇卡效果
    processJiyuCard(socket, current, pendingJiyu);
  });

  function processJiyuCard(socket, current, selectedJiyu) {
      qiyuState = {
        playerId: current.id,
        playerName: current.name,
        playerColor: current.color,
        qiyu: selectedJiyu
      };

      if (selectedJiyu.name === '旅游') {
        const neimengSpace = board.find(s => s.name === '内蒙');
        if (neimengSpace) {
          current.position = neimengSpace.id;
        }
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}：${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '喜新厌旧') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuXixinYanjiu', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '安眠药') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('jiyuCardShowWithOption', { name: selectedJiyu.name, desc: selectedJiyu.desc, playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '扒房牵牛') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('jiyuCardShowWithOption', { name: '扒房', desc: selectedJiyu.desc, playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '栽赃') {
        const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
        if (validTargets.length === 0) {
          qiyuState = null;
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}：没有合适的目标`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuZaizang', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '封地') {
        const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
        if (validTargets.length === 0) {
          qiyuState = null;
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}：没有合适的目标`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuFengdi', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '你来我往') {
        qiyuState.selectCount = 0;
        qiyuState.selectedTargets = [];
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuNilaiWangwang', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '美人计') {
        const activePlayers = players.filter(p => !p.bankrupt);
        if (activePlayers.length < 2) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}`, playerId: current.id });
          return;
        }
        qiyuState.selectCount = 0;
        qiyuState.selectedTargets = [];
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuMeirenji', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '圣母') {
        const activePlayers = players.filter(p => !p.bankrupt);
        let minPropCount = Infinity;
        activePlayers.forEach(p => {
          const count = board.filter(s => s.isProperty && s.owner === p.id).length;
          if (count < minPropCount) minPropCount = count;
        });
        const minPlayers = activePlayers.filter(p => board.filter(s => s.isProperty && s.owner === p.id).length === minPropCount);
        const target = minPlayers[Math.floor(Math.random() * minPlayers.length)];
        previewMoney(current.id, -10);
        previewMoney(target.id, 10);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `圣母：交给地产数最少的人10（${coloredName(current.name, current.color)}给${coloredName(target.name, target.color)}10）` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '蛊惑') {
        const others = players.filter(p => !p.bankrupt && p.id !== current.id);
        if (others.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuGuhuo', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '赶尽杀绝') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('jiyuCardShowWithOption', { name: selectedJiyu.name, desc: selectedJiyu.desc, playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '联姻') {
        const myProps = board.filter(s => s.isProperty && s.owner === current.id);
        if (myProps.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuLianyin', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '因祸得福') {
        const myProps = board.filter(s => s.isProperty && s.owner === current.id);
        if (myProps.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuYinhuoDefu', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '躺赢') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuTangying', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '传销') {
        const activePlayers = players.filter(p => !p.bankrupt);
        if (activePlayers.length < 2) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuChuanxiaoTrigger', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '搏命') {
        const others = players.filter(p => !p.bankrupt && p.id !== current.id);
        if (others.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuBoming', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '劫富济贫') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('jiyuCardShowWithOption', { name: '劫富', desc: selectedJiyu.desc, playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '风水轮流转') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuLunliuzhuan', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '现金流水') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuXianjinLiushui', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '走私贩子') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuZoushoufanzi', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '禁足') {
        const others = players.filter(p => !p.bankrupt && p.id !== current.id);
        if (others.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuJinzu', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '湖南赶尸') {
        const validTargets = players.filter(p => !p.bankrupt && !p.sheltered);
        if (validTargets.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuHunanganshi', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '乐善好施') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuLeshanHaoshi', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '流放') {
        if (current.money < 11) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（金钱不足）`, playerId: current.id });
          return;
        }
        const others = players.filter(p => !p.bankrupt && p.id !== current.id);
        if (others.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuLiufang', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '结伴玩乐') {
        const others = players.filter(p => !p.bankrupt && p.id !== current.id);
        if (others.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuJiebanWanle', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '拖累') {
        const others = players.filter(p => !p.bankrupt && p.id !== current.id);
        if (others.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuTuolei', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '服务费') {
        const others = players.filter(p => !p.bankrupt && p.id !== current.id);
        if (others.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuFuwufei', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '闻鸡起舞') {
        current.wenjigifwu = true;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuWenjigifwu', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '贪污') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuTanwu', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '被陨石砸中') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuYunshi', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '直播睡觉') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuZhiboShuijiao', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '宴会') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuYanhui', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      if (selectedJiyu.name === '爱屋及乌') {
        const myProperties = board.filter(s => s.isProperty && s.owner === current.id);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuAiwuJiwu', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu,
          hasProperty: myProperties.length > 0
        });
        return;
      }

      if (selectedJiyu.name === '土地兼并') {
        const myProperties = board.filter(s => s.isProperty && s.owner === current.id);
        const othersWithProperty = players.filter(p => p.id !== current.id && !p.bankrupt && board.some(s => s.isProperty && s.owner === p.id));
        const canExecute = myProperties.length > 0 && othersWithProperty.length > 0;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuTudijianbing', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu,
          canExecute
        });
        return;
      }

      if (selectedJiyu.name === '笑里藏刀') {
        const myProperties = board.filter(s => s.isProperty && s.owner === current.id);
        const hasProperty = myProperties.length > 0;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('qiyuXiaolicangdao', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu,
          hasProperty
        });
        return;
      }

      if (selectedJiyu.name === '下毒') {
        const targetsWithPet = players.filter(p => p.id !== current.id && !p.bankrupt && p.petImage);
        const hasTarget = targetsWithPet.length > 0;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('qiyuXiadu', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu,
          hasTarget
        });
        return;
      }

      if (selectedJiyu.name === '抓住小偷') {
        previewMoney(current.id, 10);
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '遇见小偷') {
        previewMoney(current.id, -8);
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '笨鸟先飞') {
        current.extraTurns = (current.extraTurns || 0) + 1;
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '考研报名') {
        previewMoney(current.id, -6);
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '街头斗殴') {
        const targets = players.filter(p => p.id !== current.id && !p.bankrupt);
        const hasTarget = targets.length > 0;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('qiyuJietouDouru', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu,
          hasTarget
        });
        return;
      }

      if (selectedJiyu.name === '网红打卡') {
        const chongqingSpace = board.find(s => s.name === '重庆');
        if (chongqingSpace) {
          current.position = chongqingSpace.id;
          current.skipGridEffect = true;
        }
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '搬砖达人') {
        const myProperties = board.filter(s => s.isProperty && s.owner === current.id && s.houseLevel < 4);
        const hasProperty = myProperties.length > 0 && current.money >= 15;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('qiyuBanzhuanDaren', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu,
          hasProperty
        });
        return;
      }

      if (selectedJiyu.name === '街头卖艺') {
        let totalGain = 0;
        players.forEach(p => {
          if (p.id !== current.id && !p.bankrupt) {
            const give = Math.min(6, p.money);
            if (give > 0) {
              previewMoney(p.id, -give);
              totalGain += give;
            }
          }
        });
        if (totalGain > 0) {
          previewMoney(current.id, totalGain);
        }
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '被狗咬') {
        previewMoney(current.id, -10);
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '受难') {
        qiyuState = null;
        current.zaie = (current.zaie || 0) + 3;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}获得灾厄3回合` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '工作过度') {
        qiyuState = null;
        applyRest(current.id, 1, `${selectedJiyu.name}:${selectedJiyu.desc}`, socket);
        return;
      }

      if (selectedJiyu.name === '反转') {
        fanzhuanState = {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color,
          currentChoice: null,
          otherChoices: {},
          phase: 'selecting'
        };
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('qiyuFanzhuanStart', {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color
        });
        return;
      }

      if (selectedJiyu.name === '心理学') {
        xinlixueState = {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color,
          choices: {},
          phase: 'selecting'
        };
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('qiyuXinlixueStart', {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color
        });
        return;
      }

      if (selectedJiyu.name === '连环计') {
        const nextPlayerIdx = (currentPlayerIndex + 1) % players.length;
        let nextPlayer = players[nextPlayerIdx];
        while (nextPlayer.bankrupt && nextPlayerIdx !== currentPlayerIndex) {
          nextPlayerIdx = (nextPlayerIdx + 1) % players.length;
          nextPlayer = players[nextPlayerIdx];
        }
        lianhuanjiState = {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color,
          currentChoice: null,
          nextPlayerId: nextPlayer.id,
          nextPlayerName: nextPlayer.name,
          nextPlayerColor: nextPlayer.color,
          nextChoice: null,
          phase: 'selecting',
          originalPlayerId: current.id
        };
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('qiyuLianhuanjiStart', {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color,
          nextPlayerId: nextPlayer.id,
          nextPlayerName: nextPlayer.name,
          nextPlayerColor: nextPlayer.color
        });
        return;
      }

      if (selectedJiyu.name === '收买') {
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('qiyuShoumaiStart', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color
        });
        return;
      }

      if (selectedJiyu.name === '暗度陈仓') {
        const targetsWithProps = players.filter(p => p.id !== current.id && !p.bankrupt && board.filter(s => s.isProperty && s.owner === p.id).length >= 2);
        const hasTarget = targetsWithProps.length > 0;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('qiyuAnduchengcangStart', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          hasTarget,
          targets: targetsWithProps.map(p => ({ id: p.id, name: p.name, color: p.color }))
        });
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '乾坤大挪移') {
        const targets = players.filter(p => p.id !== current.id && !p.bankrupt);
        const hasTarget = targets.length > 0;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('qiyuQiankundanayiStart', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          hasTarget
        });
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '踏破铁鞋') {
        const emptyProps = board.filter(s => s.isProperty && !s.owner && s.price < 36);
        if (emptyProps.length === 0) {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: '踏破铁鞋：没有空地' });
          socket.emit('showEndTurn');
        } else {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
          io.emit('qiyuTapieStart', { playerId: current.id, playerName: current.name, playerColor: current.color });
        }
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '厌学') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('qiyuYanxueStart', { playerId: current.id, playerName: current.name, playerColor: current.color });
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '考试满分') {
        previewMoney(current.id, 5);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '劳模') {
        const mianxiuCard = cardData.find(c => c.id === 5);
        if (mianxiuCard) addCardToPlayer(current, mianxiuCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '歹徒') {
        const qiangjieCard = cardData.find(c => c.id === 1);
        if (qiangjieCard) addCardToPlayer(current, qiangjieCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '守护') {
        const baohuCard = cardData.find(c => c.id === 4);
        if (baohuCard) addCardToPlayer(current, baohuCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '龟速') {
        const wuguiCard = cardData.find(c => c.id === 2);
        if (wuguiCard) addCardToPlayer(current, wuguiCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '倒带') {
        const daotuiCard = cardData.find(c => c.id === 16);
        if (daotuiCard) addCardToPlayer(current, daotuiCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '国庆节') {
        const mianlufeiCard = cardData.find(c => c.id === 18);
        if (mianlufeiCard) addCardToPlayer(current, mianlufeiCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '巧手') {
        const duogongnengCard = cardData.find(c => c.id === 27);
        if (duogongnengCard) addCardToPlayer(current, duogongnengCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '大意') {
        let message = `${selectedJiyu.name}:随机失去一张卡`;
        if (!current.cards || current.cards.length === 0) {
          message += '（没有卡片）';
        } else {
          const randomIndex = Math.floor(Math.random() * current.cards.length);
          const lostCard = current.cards.splice(randomIndex, 1)[0];
          message += `（失去${lostCard.name}）`;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '炸弹狂人') {
        const zhadanCard = cardData.find(c => c.id === 14);
        if (zhadanCard) addCardToPlayer(current, zhadanCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '基建') {
        const jianfangCard = cardData.find(c => c.id === 17);
        if (jianfangCard) addCardToPlayer(current, jianfangCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '德克萨斯州') {
        const longjuanfengCard = cardData.find(c => c.id === 19);
        if (longjuanfengCard) addCardToPlayer(current, longjuanfengCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '命运') {
        const diceId = Math.floor(Math.random() * 6) + 7;
        const diceCard = cardData.find(c => c.id === diceId);
        if (diceCard) addCardToPlayer(current, diceCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '拆迁') {
        const qiangchaiCard = cardData.find(c => c.id === 23);
        if (qiangchaiCard) addCardToPlayer(current, qiangchaiCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '开发') {
        const zhengdiCard = cardData.find(c => c.id === 24);
        if (zhengdiCard) addCardToPlayer(current, zhengdiCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '缅北旅游') {
        const freezeAmount = Math.min(17, current.money);
        if (freezeAmount > 0) {
          current.money -= freezeAmount;
          current.frozen = (current.frozen || 0) + freezeAmount;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '奋斗') {
        current.salary = (current.salary || 10) + 2;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '迟到') {
        current.salary = Math.max(1, (current.salary || 10) - 2);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '铁门') {
        const hasKey = current.cards && current.cards.some(c => c.id === 13);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuTiemen', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu,
          hasKey
        });
        return;
      }

      if (selectedJiyu.name === '银门') {
        const hasKey = current.cards && current.cards.some(c => c.id === 13);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuYinmen', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu,
          hasKey
        });
        return;
      }

      if (selectedJiyu.name === '翻山') {
        const yunguiSpace = board.find(s => s.name === '云贵');
        if (yunguiSpace) {
          current.position = yunguiSpace.id;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '国内旅游') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuGuoneiLvyou', { playerId: current.id });
        qiyuState = { type: 'guoneilvyou' };
        return;
      }

      if (selectedJiyu.name === '夺宝') {
        if (diamondHolder === current.id) {
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（已经是你的钻石）` });
        } else {
          if (diamondHolder && diamondHolder !== true) {
            const oldHolder = players.find(p => p.id === diamondHolder);
            if (oldHolder) oldHolder.hasDiamond = false;
          }
          current.hasDiamond = true;
          diamondHolder = current.id;
          diamondProgress = 0;
          diamondProgressPlayerId = current.id;
          diamondProgressPlayerColor = current.color;
          io.emit('diamondProgressUpdate', { playerId: current.id, playerColor: current.color, progress: 0 });
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        }
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '砸锅卖铁') {
        const playerProperties = board.filter(s => s.isProperty && s.owner === current.id);
        if (playerProperties.length === 0) {
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有地产可拍卖）` });
          socket.emit('showEndTurn');
          qiyuState = null;
          return;
        }
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('zagumaitieSelect', { playerId: current.id, playerColor: current.color });
        qiyuState = { type: 'zagumaitie' };
        return;
      }

      if (selectedJiyu.name === '霉运') {
        const diceValue = Math.floor(Math.random() * 6) + 1;
        const loss = 3 * diceValue;
        current.money -= loss;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（-${loss}）` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '刮痧') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const others = players.filter(p => p.id !== current.id && !p.bankrupt && p.money > 50);
        if (others.length === 0) {
          io.emit('updateAreaE', { message: '刮痧：没有合适的目标' });
          socket.emit('showEndTurn');
          qiyuState = null;
          return;
        }
        guashaState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('guashaStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '交易') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const myProps = board.filter(s => s.isProperty && s.owner === current.id);
        if (myProps.length === 0) {
          io.emit('updateAreaE', { message: '交易：没有地产交易' });
          socket.emit('showEndTurn');
          qiyuState = null;
          return;
        }
        jiaoyiState = { currentId: current.id, targetId: null, currentPropId: null, targetPropId: null };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('jiaoyiStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '择木而栖') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        zemuerqiState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('zemuerqiStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '自爆卡车') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const myProps = board.filter(s => s.isProperty && s.owner === current.id);
        if (myProps.length === 0) {
          io.emit('updateAreaE', { message: '自爆卡车：没有地产可自爆' });
          socket.emit('showEndTurn');
          qiyuState = null;
          return;
        }
        zibaoState = { playerId: current.id, selections: {} };
        const allPlayers = players.filter(p => !p.bankrupt);
        allPlayers.forEach(p => {
          const playerProps = board.filter(s => s.isProperty && s.owner === p.id);
          if (playerProps.length > 0) {
            zibaoState.selections[p.id] = null;
          }
        });
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('zibaoStart', { playerId: current.id, playerName: current.name, playerColor: current.color });
        return;
      }

      if (selectedJiyu.name === '机会') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        jihuiState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('jihuiStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '神兵天降') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        shenbingState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('shenbingStart', { playerId: current.id, currentPos: current.position });
        return;
      }

      if (selectedJiyu.name === '搬家') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const myPropsWithHouse = board.filter(s => s.isProperty && s.owner === current.id && s.houseLevel > 0);
        const myPropsCount = board.filter(s => s.isProperty && s.owner === current.id).length;
        if (myPropsWithHouse.length === 0) {
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有房屋）` });
          socket.emit('showEndTurn');
          qiyuState = null;
          return;
        }
        if (myPropsCount < 2) {
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有搬家目的地）` });
          socket.emit('showEndTurn');
          qiyuState = null;
          return;
        }
        banjiaState = { playerId: current.id, step: 'selectSource', sourcePropId: null, targetPropId: null };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('banjiaStart', { playerId: current.id, step: 'selectSource' });
        return;
      }

      if (selectedJiyu.name === '阶层滑落') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const myPropsWithHouse = board.filter(s => s.isProperty && s.owner === current.id && s.houseLevel > 0);
        if (myPropsWithHouse.length === 0) {
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有房屋）` });
          socket.emit('showEndTurn');
          qiyuState = null;
          return;
        }
        const randomProp = myPropsWithHouse[Math.floor(Math.random() * myPropsWithHouse.length)];
        randomProp.houseLevel = Math.max(0, randomProp.houseLevel - 1);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（${randomProp.name}降级）` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '混水摸鱼') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const othersWithCards = players.filter(p => p.id !== current.id && !p.bankrupt && p.cards && p.cards.length > 0);
        if (othersWithCards.length === 0) {
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有合适的目标）` });
          socket.emit('showEndTurn');
          qiyuState = null;
          return;
        }
        hunshuiState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('hunshuiStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '联合') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        lianheState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('lianheStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '打草惊蛇') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const othersWithProperty = players.filter(p => p.id !== current.id && !p.bankrupt && board.some(s => s.isProperty && s.owner === p.id));
        if (othersWithProperty.length === 0) {
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有合适的地产）` });
          socket.emit('showEndTurn');
          qiyuState = null;
          return;
        }
        dacaoState = {
          playerId: current.id,
          targetPropId: null,
          targetOwnerId: null,
          responses: {}
        };
        const othersWithPropertyIds = othersWithProperty.map(p => p.id);
        othersWithPropertyIds.forEach(id => {
          dacaoState.responses[id] = null;
        });
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('dacaoStart', { playerId: current.id, playerName: current.name, playerColor: current.color });
        return;
      }

      if (selectedJiyu.name === '孩子套狼') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        haiziState = {
          playerId: current.id,
          responses: {}
        };
        const allPlayers = players.filter(p => !p.bankrupt);
        allPlayers.forEach(p => {
          haiziState.responses[p.id] = null;
        });
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('haiziStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '恶人先告状') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const others = players.filter(p => p.id !== current.id && !p.bankrupt);
        if (others.length === 0) {
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有合适的目标）` });
          socket.emit('showEndTurn');
          qiyuState = null;
          return;
        }
        erenState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('erenStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '强买') {
        const validProps = board.filter(s => s.isProperty && s.owner && s.owner !== current.id && s.houseLevel === 0);
        if (validProps.length === 0) {
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有合适的目标）` });
          socket.emit('showEndTurn');
          qiyuState = null;
          return;
        }
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        qiangmaiState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiangmaiStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '调虎离山') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const others = players.filter(p => p.id !== current.id && !p.bankrupt);
        if (others.length === 0) {
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有合适的目标）` });
          socket.emit('showEndTurn');
          qiyuState = null;
          return;
        }
        diaohuState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('diaohuStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '抛砖引玉') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        paozhuanState = { playerId: current.id, targetId: null, currentPropId: null, targetPropId: null };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('paozhuanStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '远交近攻') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        yuanjiaoState = { playerId: current.id, targetA: null, targetB: null };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('yuanjiaoStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '闪现') {
        const shanxianCard = cardData.find(c => c.id === 22);
        if (shanxianCard) addCardToPlayer(current, shanxianCard);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        qiyuState = null;
        return;
      }

      if (selectedJiyu.name === '瞬移') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        shunyiState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('shunyiStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '智力节目') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        zhilijiemuState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('zhilijiemuStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '重金求宠') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        zhongjinState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('zhongjinStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '万人迷') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        wanrenmiState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('wanrenmiStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '同步') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        tongbuState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('tongbuStart', { playerId: current.id, diceValue: currentDiceValue });
        return;
      }

      if (selectedJiyu.name === '陷害') {
        const others = getValidTargets(current.id);
        if (others.length === 0) {
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有合适的目标）` });
          socket.emit('showEndTurn');
          return;
        }
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        xianhaiState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('xianhaiStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '车祸') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        chehuoState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('chehuoStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '难题') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        nantiState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('nantiStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '水果机') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        shuiguojiState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('shuiguojiStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '吸铁石') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const others = players.filter(p => p.id !== current.id && !p.bankrupt);
        if (others.length === 0) {
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有合适的目标）` });
          socket.emit('showEndTurn');
          return;
        }
        xitieshiState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('xitieshiStart', { playerId: current.id, currentPos: current.position });
        return;
      }

      if (selectedJiyu.name === '离间') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        lijianState = { playerId: current.id, targetA: null, targetB: null, currentTurn: null, eMsg: '' };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('lijianStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '无中生有') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        wuzhongshengyouState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('wuzhongshengyouStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '攻城') {
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        gongchengState = { playerId: current.id };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('gongchengStart', { playerId: current.id });
        return;
      }

      if (selectedJiyu.name === '赃款') {
        const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
        if (validTargets.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有合适的目标）`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('zangkuanStart', { playerId: current.id, playerName: current.name, playerColor: current.color, qiyu: selectedJiyu });
        return;
      }

      if (selectedJiyu.name === '小偷') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('xiaotouStart', { playerId: current.id, playerName: current.name, playerColor: current.color, qiyu: selectedJiyu });
        return;
      }

      if (selectedJiyu.name === '千变') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qianbianStart', { playerId: current.id, playerName: current.name, playerColor: current.color, qiyu: selectedJiyu });
        return;
      }

      if (selectedJiyu.name === '租金') {
        const propertyCount = board.filter(s => s.isProperty && s.owner === current.id).length;
        const gain = propertyCount * 4;
        if (gain > 0) {
          previewMoney(current.id, gain);
        }
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（+${gain}）` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '大地主') {
        const allProperties = board.filter(s => s.isProperty);
        dizhuState = {
          playerId: current.id,
          originalOwners: allProperties.map(s => ({ id: s.id, owner: s.owner }))
        };
        allProperties.forEach(s => { s.owner = current.id; });
        current.dizhuTurns = 2;
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '残肢') {
        const myProperties = board.filter(s => s.isProperty && s.owner === current.id);
        if (myProperties.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（无地产）` });
          socket.emit('showEndTurn');
          return;
        }
        const randomProp = myProperties[Math.floor(Math.random() * myProperties.length)];
        canzhiState = { playerId: current.id, propertyId: randomProp.id };
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('canzhiStart', { playerId: current.id, playerName: current.name, playerColor: current.color, qiyu: selectedJiyu, propertyName: randomProp.name, propertyId: randomProp.id });
        return;
      }

      if (selectedJiyu.name === '议案') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('yianStart', { playerId: current.id, playerName: current.name, playerColor: current.color, qiyu: selectedJiyu });
        return;
      }

      if (selectedJiyu.name === '封控') {
        const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
        if (validTargets.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有合适的目标）`, playerId: current.id });
          return;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('fengkongStart', { playerId: current.id, playerName: current.name, playerColor: current.color, qiyu: selectedJiyu });
        return;
      }

      if (selectedJiyu.name === '暴政') {
        const otherActive = players.filter(p => !p.bankrupt && p.id !== current.id);
        if (otherActive.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有其他玩家）`, playerId: current.id });
          return;
        }
        baozhengState = {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color,
          choices: {},
          phase: 'selecting',
          round: 1
        };
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('baozhengStart', {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color
        });
        return;
      }

      if (selectedJiyu.name === '倒影') {
        const otherActive = players.filter(p => !p.bankrupt && p.id !== current.id);
        daoyingState = {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color,
          currentChoice: null,
          targetId: null,
          targetChoice: null,
          phase: 'selecting',
          hasTarget: otherActive.length > 0
        };
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('daoyingStart', {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color,
          hasTarget: otherActive.length > 0
        });
        return;
      }

      if (selectedJiyu.name === '地产税') {
        const propertyCount = board.filter(s => s.isProperty && s.owner === current.id).length;
        const loss = propertyCount * 3;
        if (loss > 0) {
          previewMoney(current.id, -loss);
        }
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（-${loss}）` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '存钱') {
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('cunqianStart', { playerId: current.id, playerName: current.name, playerColor: current.color });
        return;
      }

      if (selectedJiyu.name === '德州') {
        const otherActive = players.filter(p => !p.bankrupt && p.id !== current.id);
        if (otherActive.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有其他玩家）`, playerId: current.id });
          return;
        }
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('dezhouStart', { playerId: current.id, playerName: current.name, playerColor: current.color });
        return;
      }

      if (selectedJiyu.name === '轮次') {
        const otherActive = players.filter(p => !p.bankrupt && p.id !== current.id);
        if (otherActive.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有其他玩家）`, playerId: current.id });
          return;
        }
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('lunciStartSelect', { playerId: current.id, playerName: current.name, playerColor: current.color });
        return;
      }

      if (selectedJiyu.name === '先知') {
        const threeJiyus = [];
        for (let i = 0; i < 3; i++) {
          const totalWeight = jiyuList.reduce((s, j) => s + (j.weight !== undefined ? j.weight : 1), 0);
          let r = Math.random() * totalWeight;
          let picked = jiyuList[jiyuList.length - 1];
          for (const j of jiyuList) {
            r -= (j.weight !== undefined ? j.weight : 1);
            if (r <= 0) { picked = j; break; }
          }
          threeJiyus.push(picked);
        }
        xianzhiState = {
          playerId: current.id,
          jiyus: threeJiyus
        };
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('xianzhiStart', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          jiyus: threeJiyus.map(j => ({ id: j.id, name: j.name, desc: j.desc }))
        });
        return;
      }

      if (selectedJiyu.name === '推算') {
        const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
        if (validTargets.length === 0) {
          qiyuState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有合适的目标）`, playerId: current.id });
          return;
        }
        const target = validTargets[Math.floor(Math.random() * validTargets.length)];
        const W = Math.floor(Math.random() * (1000 - 25 + 1)) + 25;
        const numbers = [];
        for (let i = 0; i < 5; i++) {
          numbers.push(Math.floor(Math.random() * (W + 1)));
        }
        tuisuanState = {
          currentPlayerId: current.id,
          targetPlayerId: target.id,
          W: W,
          numbers: numbers,
          currentGuess: null,
          targetGuess: null
        };
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('tuisuanStart', {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color,
          targetPlayerId: target.id,
          targetPlayerName: target.name,
          targetPlayerColor: target.color,
          numbers: numbers
        });
        return;
      }

      if (selectedJiyu.name === '双面间谍') {
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        io.emit('jiandieStart', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color
        });
        return;
      }

      if (selectedJiyu.name === '卡波') {
        qiyuState = null;
        const otherPlayers = players.filter(p => !p.bankrupt && p.id !== current.id);
        if (otherPlayers.length === 0) {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}，没有合适的目标` });
          socket.emit('showEndTurn');
          return;
        }
        const opponent = otherPlayers[Math.floor(Math.random() * otherPlayers.length)];
        const deck = [];
        for (let i = 0; i < 4; i++) {
          for (let v = 1; v <= 13; v++) {
            deck.push(v);
          }
        }
        for (let i = deck.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        const playerCards = [deck.pop(), deck.pop(), deck.pop(), deck.pop()];
        const opponentCards = [deck.pop(), deck.pop(), deck.pop(), deck.pop()];
        caboState = {
          callerId: current.id,
          callerName: current.name,
          callerColor: current.color,
          opponentId: opponent.id,
          opponentName: opponent.name,
          opponentColor: opponent.color,
          deck: deck,
          discardPile: [],
          playerCards: playerCards,
          opponentCards: opponentCards,
          currentTurnId: current.id,
          caboCalled: false,
          caboCallerId: null,
          lastTurnId: null,
          phase: 'peek',
          playerPeeked: 0,
          opponentPeeked: 0,
          playerPeekIndices: [],
          opponentPeekIndices: [],
          drawnCard: null,
          actionPhase: null,
          playerFaceUp: [],
          opponentFaceUp: []
        };
        caboOpponentMap[current.id] = opponent.id;
        caboOpponentMap[opponent.id] = current.id;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `卡波:与随机对手卡波！尽可能让自己的牌点数小，输给赢家12` });
        io.emit('caboStart', {
          callerId: current.id,
          callerName: current.name,
          callerColor: current.color,
          opponentId: opponent.id,
          opponentName: opponent.name,
          opponentColor: opponent.color
        });
        const callerSocket = io.sockets.sockets.get(current.id);
        if (callerSocket) {
          callerSocket.emit('caboInit', {
            row3Name: current.name,
            row3Color: current.color,
            row3Cards: playerCards,
            row4Name: opponent.name,
            row4Color: opponent.color,
            row4Cards: [0, 0, 0, 0],
            myRow: 3,
            isCaller: true
          });
        }
        const opponentSocket = io.sockets.sockets.get(opponent.id);
        if (opponentSocket) {
          opponentSocket.emit('caboInit', {
            row3Name: current.name,
            row3Color: current.color,
            row3Cards: [0, 0, 0, 0],
            row4Name: opponent.name,
            row4Color: opponent.color,
            row4Cards: opponentCards,
            myRow: 4,
            isCaller: false
          });
        }
        caboSpectators = new Set();
        players.forEach(p => {
          if (p.id !== current.id && p.id !== opponent.id) {
            caboSpectators.add(p.id);
          }
        });
        const maskCards = (cards, faceUp) => cards.map((c, i) => (faceUp.includes(i) || c === -1) ? c : 0);
        caboSpectators.forEach(specId => {
          const specSocket = io.sockets.sockets.get(specId);
          if (specSocket) {
            specSocket.emit('caboInit', {
              row3Name: current.name,
              row3Color: current.color,
              row3Cards: maskCards(playerCards, []),
              row4Name: opponent.name,
              row4Color: opponent.color,
              row4Cards: maskCards(opponentCards, []),
              myRow: 0,
              isCaller: false
            });
          }
        });
        return;
      }

      if (selectedJiyu.name === '瞒天过海') {
        qiyuState = null;
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        mantianGuohaiState = {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color,
          choices: {},
          waitingPlayers: players.filter(p => !p.bankrupt && p.id !== current.id).map(p => p.id),
          phase: 'currentPlayerSelect'
        };
        io.to(current.id).emit('mantianGuohaiCurrentPlayerSelect', {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color
        });
        return;
      }

      if (selectedJiyu.name === '合作任务') {
        qiyuState = null;
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const targets = players.filter(p => p.id !== current.id && !p.bankrupt);
        if (targets.length === 0) {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}，没有合适的目标` });
          socket.emit('showEndTurn');
        } else {
          hezuorenwuState = {
            currentPlayerId: current.id,
            currentPlayerName: current.name,
            currentPlayerColor: current.color,
            targetId: null,
            targetName: null,
            targetColor: null,
            currentPlayerMoney: null,
            targetPlayerMoney: null,
            phase: 'selectTarget'
          };
          socket.emit('hezuorenwuStart', {
            playerId: current.id,
            targets: targets.map(p => ({ id: p.id, name: p.name, color: p.color }))
          });
        }
        return;
      }

      if (selectedJiyu.name === '迷惑') {
        qiyuState = null;
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const targets = players.filter(p => p.id !== current.id && !p.bankrupt);
        if (targets.length === 0) {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}，没有合适的目标` });
          socket.emit('showEndTurn');
        } else {
          meihuoState = {
            currentPlayerId: current.id,
            currentPlayerName: current.name,
            currentPlayerColor: current.color,
            targetId: null,
            targetName: null,
            targetColor: null,
            chosenDice: null,
            randomDice1: null,
            randomDice2: null,
            shuffledDice: [],
            phase: 'selectTarget'
          };
          socket.emit('meihuoStart', {
            playerId: current.id,
            targets: targets.map(p => ({ id: p.id, name: p.name, color: p.color }))
          });
        }
        return;
      }

      if (selectedJiyu.name === '打猎') {
        qiyuState = null;
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        dalieState = {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color,
          score: 0,
          timeLeft: 20,
          gameStarted: false,
          gameOver: false,
          hitHuman: false
        };
        io.emit('dalieStart', {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color
        });
        return;
      }

      if (selectedJiyu.name === '寻仙') {
        qiyuState = null;
        if (!kunlunState || kunlunState.playerId !== current.id) {
          kunlunState = { playerId: current.id, playerName: current.name, playerColor: current.color, progress: 0 };
        } else {
          kunlunState.progress++;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, kunlunState });
        io.emit('kunlunArrive', { playerId: current.id, playerName: current.name, playerColor: current.color, progress: kunlunState.progress });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '金花') {
        qiyuState = null;
        const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
        if (validTargets.length === 0) {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
          io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}（没有合适的目标）` });
          socket.emit('showEndTurn');
          return;
        }
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const allPlayers = [current, ...validTargets];
        const playerData = allPlayers.map(p => ({
          id: p.id,
          name: p.name,
          color: p.color,
          cards: [],
          cardSum: 0,
          betCount: 0,
          gaveUp: false,
          swapped: false
        }));
        jinhuaState = {
          currentPlayerId: current.id,
          players: playerData,
          phase: 'draw',
          currentBetPlayerIndex: 0,
          bankCards: [],
          bankSum: 0
        };
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('jinhuaStart', {
          currentPlayerId: current.id,
          players: playerData.map(p => ({ id: p.id, name: p.name, color: p.color }))
        });
        return;
      }

      if (selectedJiyu.name === '精算') {
        qiyuState = null;
        io.emit('updateAreaE', { message: `${selectedJiyu.name}:${selectedJiyu.desc}` });
        const cards = drawPukepaiCards(9);
        jingsuanState = {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color,
          cards: cards,
          timeLeft: 20,
          gameStarted: false,
          gameOver: false,
          upperCards: [...cards],
          topZone: [],
          bottomZone: []
        };
        io.emit('jingsuanStart', {
          currentPlayerId: current.id,
          currentPlayerName: current.name,
          currentPlayerColor: current.color,
          cards: cards
        });
        return;
      }

      if (selectedJiyu.name === '镜花' || selectedJiyu.name === '水月' || selectedJiyu.name === '雾里看花') {
        qiyuState = null;
        let amount = 10;
        if (selectedJiyu.name === '水月') amount = 15;
        if (selectedJiyu.name === '雾里看花') amount = 20;
        grantTempMoney(current.id, amount, 3);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${selectedJiyu.name}：临时金钱+${amount}` });
        socket.emit('showEndTurn');
        return;
      }

      if (selectedJiyu.name === '拔罐') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuBaguan', {
          playerId: current.id,
          playerName: current.name,
          playerColor: current.color,
          qiyu: selectedJiyu
        });
        return;
      }

      // 查封/造谣/繁荣等需要选择地产的卡牌：先显示选项
      if (['查封', '造谣', '繁荣'].includes(selectedJiyu.name)) {
        io.emit('jiyuCardShowWithOption', { name: selectedJiyu.name, desc: selectedJiyu.desc, playerId: current.id });
        return;
      }

      const propertiesWithOwner = board.filter(s => s.isProperty && s.owner !== null);
      if (propertiesWithOwner.length === 0) {
        qiyuState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}:${selectedJiyu.desc}`, playerId: current.id });
        return;
    }
    
    io.emit('bAreaOverlayClose');
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('qiyuSelectProperty', {
        playerId: current.id,
        playerName: current.name,
        playerColor: current.color,
        qiyu: selectedJiyu
      });
  }

  socket.on('jiyuCardUse', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!qiyuState) return;
    const selectedJiyu = qiyuState.qiyu;

    if (selectedJiyu.name === '旅游') {
      const neimengSpace = board.find(s => s.name === '内蒙');
      if (neimengSpace) {
        current.position = neimengSpace.id;
      }
      qiyuState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${selectedJiyu.name}：${selectedJiyu.desc}` });
      socket.emit('showEndTurn');
      return;
    }

    if (selectedJiyu.name === '封地') {
      const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
      if (validTargets.length === 0) {
        qiyuState = null;
        io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}：没有合适的目标`, playerId: current.id });
        return;
      }
      io.emit('qiyuFengdi', {
        playerId: current.id,
        playerName: current.name,
        playerColor: current.color,
        qiyu: selectedJiyu
      });
      return;
    }

    if (selectedJiyu.name === '安眠药') {
      const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
      if (validTargets.length === 0) {
        qiyuState = null;
        io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}：没有合适的目标`, playerId: current.id });
        return;
      }
      io.emit('qiyuAnmianyao', {
        playerId: current.id,
        playerName: current.name,
        playerColor: current.color,
        qiyu: selectedJiyu
      });
      return;
    }

    if (selectedJiyu.name === '赶尽杀绝') {
      const others = players.filter(p => !p.bankrupt && p.id !== current.id);
      if (others.length === 0) {
        qiyuState = null;
        io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}：没有合适的目标`, playerId: current.id });
        return;
      }
      io.emit('qiyuGanjinJuejue', {
        playerId: current.id,
        playerName: current.name,
        playerColor: current.color,
        qiyu: selectedJiyu
      });
      return;
    }

    if (selectedJiyu.name === '扒房牵牛') {
      const playersWithHouse = players.filter(p =>
        p.id !== current.id && !p.bankrupt &&
        board.some(s => s.isProperty && s.owner === p.id && s.houseLevel > 0)
      );
      if (playersWithHouse.length === 0) {
        qiyuState = null;
        io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}：没有合适的房屋`, playerId: current.id });
        return;
      }
      io.emit('qiyuBafangQianniu', {
        playerId: current.id,
        playerName: current.name,
        playerColor: current.color,
        qiyu: selectedJiyu
      });
      return;
    }

    if (selectedJiyu.name === '栽赃') {
      const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
      if (validTargets.length === 0) {
        qiyuState = null;
        io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}：没有合适的目标`, playerId: current.id });
        return;
      }
      io.emit('qiyuZaizang', {
        playerId: current.id,
        playerName: current.name,
        playerColor: current.color,
        qiyu: selectedJiyu
      });
      return;
    }

    if (selectedJiyu.name === '劫富济贫') {
      const others = players.filter(p => !p.bankrupt && p.id !== current.id);
      if (others.length < 2) {
        qiyuState = null;
        io.emit('updateAreaE', { message: '没有足够的贫富人数' });
        socket.emit('showEndTurn');
        return;
      }
      const maxMoney = Math.max(...others.map(p => p.money));
      const minMoney = Math.min(...others.map(p => p.money));
      const richest = others.filter(p => p.money === maxMoney);
      const poorest = others.filter(p => p.money === minMoney);
      const richestPlayer = richest[Math.floor(Math.random() * richest.length)];
      const poorestPlayer = poorest[Math.floor(Math.random() * poorest.length)];
      // 先发动画
      io.emit('moneyChangePreview', { playerId: richestPlayer.id, amount: -8 });
      io.emit('moneyChangePreview', { playerId: poorestPlayer.id, amount: 8 });
      io.emit('moneyChangePreview', { playerId: current.id, amount: 5 });
      // 再修改钱数
      richestPlayer.money -= 8;
      poorestPlayer.money += 8;
      current.money += 5;
      qiyuState = null;
      // 延迟发sync，让动画先显示
      setTimeout(() => {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}劫富济贫+5，${coloredName(richestPlayer.name, richestPlayer.color)}给${coloredName(poorestPlayer.name, poorestPlayer.color)}8` });
        socket.emit('showEndTurn');
      }, 800);
      return;
    }

    // 查封/造谣/繁荣：检查有主地产
    const propertiesWithOwner = board.filter(s => s.isProperty && s.owner !== null);
    if (propertiesWithOwner.length === 0) {
      qiyuState = null;
      io.emit('qiyuNoEffect', { message: `${selectedJiyu.name}：没有合适的地产`, playerId: current.id });
      return;
    }
    io.emit('qiyuSelectProperty', {
      playerId: current.id,
      playerName: current.name,
      playerColor: current.color,
      qiyu: selectedJiyu
    });
  });

  socket.on('canzhiLufei', () => {
    if (!canzhiState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const prop = board.find(s => s.id === canzhiState.propertyId);
    if (!prop) return;
    prop.rentBonus = (prop.rentBonus || 0) - 3;
    canzhiState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的${prop.name}路费-3` });
    socket.emit('showEndTurn');
  });

  socket.on('canzhiPanding', () => {
    if (!canzhiState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const prop = board.find(s => s.id === canzhiState.propertyId);
    if (!prop) return;
    const diceValue = Math.floor(Math.random() * 6) + 1;
    const doCanzhiJudge = () => {
      const newDice = Math.floor(Math.random() * 6) + 1;
      if (newDice <= 2) {
        prop.owner = null;
        prop.houses = 0;
        canzhiState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `判定为${newDice}，${coloredName(current.name, current.color)}失去${prop.name}` });
      } else {
        canzhiState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `判定为${newDice}，安然无恙` });
      }
      socket.emit('showEndTurn');
    };
    const originalResult = () => {
      if (diceValue <= 2) {
        prop.owner = null;
        prop.houses = 0;
        canzhiState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `判定为${diceValue}，${coloredName(current.name, current.color)}失去${prop.name}` });
      } else {
        canzhiState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `判定为${diceValue}，安然无恙` });
      }
      socket.emit('showEndTurn');
    };
    if (checkKoiOrDuogongnengJudge(current.id, doCanzhiJudge, originalResult)) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `判定为${diceValue}，${diceValue <= 2 ? '失去地产' : '安然无恙'}，是否重新判定？` });
      return;
    }
    if (diceValue <= 2) {
      prop.owner = null;
      prop.houses = 0;
      canzhiState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `判定为${diceValue}，${coloredName(current.name, current.color)}失去${prop.name}` });
    } else {
      canzhiState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `判定为${diceValue}，安然无恙` });
    }
    socket.emit('showEndTurn');
  });

  socket.on('yianRequestTargets', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== current.id);
    if (validTargets.length < 2) return;
    const shuffled = validTargets.sort(() => Math.random() - 0.5);
    const targetA = shuffled[0];
    const targetB = shuffled[1];
    yianState = {
      proposerId: current.id,
      proposerName: current.name,
      proposerColor: current.color,
      targetAId: targetA.id,
      targetBId: targetB.id,
      amount: 0,
      choiceA: null,
      choiceB: null
    };
    socket.emit('yianRandomTargets', {
      targetAId: targetA.id,
      targetAName: targetA.name,
      targetAColor: targetA.color,
      targetBId: targetB.id,
      targetBName: targetB.name,
      targetBColor: targetB.color
    });
  });

  socket.on('yianConfirm', ({ amount }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    if (!yianState || yianState.proposerId !== current.id) return;
    yianState.amount = amount;
    const targetA = players.find(p => p.id === yianState.targetAId);
    const targetB = players.find(p => p.id === yianState.targetBId);
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('yianTargets', {
      proposerId: current.id,
      proposerName: current.name,
      proposerColor: current.color,
      targetAId: targetA.id,
      targetAName: targetA.name,
      targetAColor: targetA.color,
      targetBId: targetB.id,
      targetBName: targetB.name,
      targetBColor: targetB.color,
      amount: amount
    });
  });

  socket.on('yianChoose', ({ choice }) => {
    if (!yianState) return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt) return;
    if (socket.id !== yianState.targetAId && socket.id !== yianState.targetBId) return;
    
    if (socket.id === yianState.targetAId) {
      yianState.choiceA = choice;
    } else {
      yianState.choiceB = choice;
    }
    
    io.emit('yianProgress', { playerId: socket.id, choice });
    
    if (yianState.choiceA !== null && yianState.choiceB !== null) {
      const proposer = players.find(p => p.id === yianState.proposerId);
      const targetA = players.find(p => p.id === yianState.targetAId);
      const targetB = players.find(p => p.id === yianState.targetBId);
      
      if (yianState.choiceA === 'success' && yianState.choiceB === 'success') {
        const diceCard = { id: 7 + Math.floor(Math.random() * 6), name: `骰子${Math.floor(Math.random() * 6) + 1}`, image: `touzi${Math.floor(Math.random() * 6) + 1}` };
        if (!proposer.cards) proposer.cards = [];
        proposer.cards.push(diceCard);
        previewMoney(proposer.id, 8);
        yianState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `议案通过，${coloredName(proposer.name, proposer.color)}获得骰子且+8` });
        io.emit('yianEnd', { proposerId: proposer.id });
      } else if (yianState.choiceA === 'success' || yianState.choiceB === 'success') {
        const successPlayer = yianState.choiceA === 'success' ? targetA : targetB;
        const amount = Math.min(yianState.amount, proposer.money);
        if (amount > 0) {
          previewMoney(proposer.id, -amount);
          previewMoney(successPlayer.id, amount);
          proposer.money -= amount;
        }
        yianState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: `${coloredName(successPlayer.name, successPlayer.color)}令议案通过，获得${coloredName(proposer.name, proposer.color)}${amount}` });
        io.emit('yianEnd', { proposerId: proposer.id });
      } else {
        yianState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('updateAreaE', { message: '议案失败' });
        io.emit('yianEnd', { proposerId: proposer.id });
      }
    }
  });

  socket.on('fengkongSelectTarget', ({ targetId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.sheltered || target.id === current.id) return;
    
    withHiddenCheck(current.id, target.id,
      (finalTarget, hiddenMsg) => {
        const otherPlayers = players.filter(p => !p.bankrupt && p.id !== finalTarget.id);
        fengkongState = {
          controllerId: current.id,
          targetId: finalTarget.id,
          targetName: finalTarget.name,
          targetColor: finalTarget.color,
          selectors: otherPlayers.map(p => ({ id: p.id, selected: [] })),
          forbiddenDice: []
        };
        
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        io.emit('fengkongSelectDice', {
          controllerId: current.id,
          targetId: finalTarget.id,
          targetName: finalTarget.name,
          targetColor: finalTarget.color,
          selectorIds: otherPlayers.map(p => p.id)
        });
      },
      () => {
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}的封控被隐藏卡取消了` });
        socket.emit('showEndTurn');
      }
    );
  });

  socket.on('fengkongSelectDice', ({ diceValues }) => {
    if (!fengkongState) return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt) return;
    
    const selector = fengkongState.selectors.find(s => s.id === socket.id);
    if (!selector) return;
    
    selector.selected = diceValues;
    fengkongState.forbiddenDice = [...new Set(fengkongState.selectors.flatMap(s => s.selected))];
    
    const allSelected = fengkongState.selectors.every(s => s.selected.length > 0);
    if (allSelected) {
      const target = players.find(p => p.id === fengkongState.targetId);
      const forbiddenDice = fengkongState.forbiddenDice;
      if (target) {
        target.fengkongDice = forbiddenDice;
      }
      const controller = players.find(p => p.id === fengkongState.controllerId);
      fengkongState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(target.name, target.color)}被封控，下回合不能掷出${forbiddenDice.join(',')}` });
      io.emit('fengkongEnd', { controllerId: controller?.id });
    } else {
      io.emit('fengkongProgress', { playerId: socket.id, selected: diceValues });
    }
  });

  socket.on('lianheSelectTarget', ({ targetId }) => {
    if (!lianheState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;
    previewMoney(current.id, 5);
    previewMoney(target.id, 5);
    lianheState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}与${coloredName(target.name, target.color)}各+5` });
    socket.emit('showEndTurn');
  });

  socket.on('dacaoGive', () => {
    if (!dacaoState) return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt) return;
    if (dacaoState.responses[socket.id] !== null) return;
    dacaoState.responses[socket.id] = true;
    const playerSocket = io.sockets.sockets.get(socket.id);
    if (playerSocket) playerSocket.emit('clearAreaF');
    checkDacaoComplete();
  });

  socket.on('dacaoNotGive', () => {
    if (!dacaoState) return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt) return;
    if (dacaoState.responses[socket.id] !== null) return;
    dacaoState.responses[socket.id] = false;
    const playerSocket = io.sockets.sockets.get(socket.id);
    if (playerSocket) playerSocket.emit('clearAreaF');
    checkDacaoComplete();
  });

  socket.on('dacaoSelectProp', ({ propId }) => {
    if (!dacaoState || dacaoState.targetPropId) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const prop = board.find(s => s.id === propId);
    if (!prop || !prop.isProperty || prop.owner === current.id || !prop.owner) return;

    dacaoState.targetPropId = propId;
    dacaoState.targetOwnerId = prop.owner;
    io.emit('dacaoPropSelected', { propId });
    checkDacaoComplete();
  });

  function checkDacaoComplete() {
    if (!dacaoState || !dacaoState.targetPropId || !dacaoState.targetOwnerId) return;
    const allResponded = Object.values(dacaoState.responses).every(v => v !== null);
    if (!allResponded) return;
    const current = players[currentPlayerIndex];
    if (!current) return;
    const targetOwner = players.find(p => p.id === dacaoState.targetOwnerId);
    const targetProp = board.find(s => s.id === dacaoState.targetPropId);
    if (!targetProp) return;

    // 先处理给钱的部分
    const gaveNames = [];
    for (const [playerId, gave] of Object.entries(dacaoState.responses)) {
      if (gave) {
        const p = players.find(pl => pl.id === playerId);
        if (p) {
          previewMoney(playerId, -7);
          gaveNames.push(coloredName(p.name, p.color));
        }
      }
    }
    if (gaveNames.length > 0) {
      previewMoney(current.id, gaveNames.length * 7);
    }
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });

    // 检查地主是否没给钱，需要路费-3
    const targetGave = dacaoState.responses[dacaoState.targetOwnerId];
    if (!targetGave && targetOwner && targetOwner.cards && targetOwner.cards.some(c => c.name === '保护卡')) {
      // 地主没给钱且有保护卡，询问是否使用
      baohuQueryState = {
        propertyId: targetProp.id,
        ownerId: targetOwner.id,
        currentPlayerId: current.id,
        source: 'dacaoRentBonus'
      };
      const ownerSocket = io.sockets.sockets.get(targetOwner.id);
      if (ownerSocket) {
        ownerSocket.emit('baohuQuery', { propertyName: targetProp.name, currentPlayerName: current.name, currentPlayerColor: current.color });
      }
      io.emit('baohuOverlay', { targetPlayerId: targetOwner.id, targetName: targetOwner.name, targetColor: targetOwner.color });
      let waitMsg = gaveNames.length > 0 ? gaveNames.join(',') + '给' + coloredName(current.name, current.color) + '7，' : '';
      waitMsg += `等待${coloredName(targetOwner.name, targetOwner.color)}决定是否使用保护卡`;
      io.emit('updateAreaE', { message: waitMsg });
      return; // 等待保护卡响应
    }

    // 没有保护卡或地主给了钱，完成处理
    finishDacaoComplete(gaveNames, targetGave, targetOwner, targetProp, current);
  }

  function finishDacaoComplete(gaveNames, targetGave, targetOwner, targetProp, current) {
    let message = '';
    if (gaveNames.length > 0) {
      message = gaveNames.join(',') + '给' + coloredName(current.name, current.color) + '7';
    }
    if (!targetGave) {
      targetProp.rentBonus = (targetProp.rentBonus || 0) - 3;
      if (message) message += '，';
      message += `${coloredName(targetOwner?.name || '未知', targetOwner?.color || '#fff')}因为不给，${targetProp.name}路费-3`;
    }
    dacaoState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message });
    const currentSocket = io.sockets.sockets.get(current.id);
    if (currentSocket) currentSocket.emit('showEndTurn');
  }

  socket.on('haiziChoice', ({ choice }) => {
    if (!haiziState) return;
    const player = players.find(p => p.id === socket.id);
    if (!player || player.bankrupt) return;
    if (haiziState.responses[socket.id] !== null) return;
    haiziState.responses[socket.id] = choice;
    const playerSocket = io.sockets.sockets.get(socket.id);
    if (playerSocket) playerSocket.emit('clearAreaF');
    const allResponded = Object.values(haiziState.responses).every(v => v !== null);
    if (allResponded) {
      const current = players[currentPlayerIndex];
      if (!current) return;
      const minusTenPlayers = [];
      const plusFourPlayers = [];
      const plusTwentyPlayers = [];
      for (const [playerId, choice] of Object.entries(haiziState.responses)) {
        const p = players.find(pl => pl.id === playerId);
        if (p) {
          if (choice === '-10') {
            minusTenPlayers.push(p);
          } else {
            plusFourPlayers.push(p);
          }
        }
      }
      const totalPlayers = minusTenPlayers.length + plusFourPlayers.length;
      if (minusTenPlayers.length > 0 && minusTenPlayers.length <= totalPlayers / 2) {
        minusTenPlayers.forEach(p => {
          previewMoney(p.id, 20);
          plusTwentyPlayers.push(p);
        });
        minusTenPlayers.length = 0;
      } else {
        minusTenPlayers.forEach(p => {
          previewMoney(p.id, -10);
        });
      }
      plusFourPlayers.forEach(p => {
        previewMoney(p.id, 4);
      });
      haiziState = null;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      const twentyNames = plusTwentyPlayers.map(p => coloredName(p.name, p.color)).join(',');
      const minusNames = minusTenPlayers.map(p => coloredName(p.name, p.color)).join(',');
      const fourNames = plusFourPlayers.map(p => coloredName(p.name, p.color)).join(',');
      let message = '';
      if (twentyNames) message += twentyNames + '+20';
      if (minusNames) message += (message ? '，' : '') + minusNames + '-10';
      if (fourNames) message += (message ? '，' : '') + fourNames + '+4';
      io.emit('updateAreaE', { message });
      const currentSocket = io.sockets.sockets.get(current.id);
      if (currentSocket) currentSocket.emit('showEndTurn');
    }
  });

  socket.on('erenSelectTarget', ({ targetId }) => {
    if (!erenState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;
    withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
      if (finalTarget.bankrupt) {
        erenState = null;
        socket.emit('showEndTurn');
        return;
      }
      previewMoney(finalTarget.id, -4);
      previewMoney(current.id, 4);
      erenState = null;
      sendToJail(finalTarget.id, '恶人先告状', () => {
        io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}掠夺${coloredName(finalTarget.name, finalTarget.color)}4并令其进监狱` });
        socket.emit('showEndTurn');
      });
    }, () => {
      erenState = null;
      socket.emit('showEndTurn');
    });
  });

  socket.on('qiangmaiSelectProp', ({ propId }) => {
    if (!qiangmaiState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const prop = board.find(s => s.id === propId);
    if (!prop || !prop.isProperty || !prop.owner || prop.owner === current.id || prop.houseLevel > 0) return;
    const owner = players.find(p => p.id === prop.owner);
    if (!owner) return;
    const price = prop.price + 10;
    if (current.money < price) return;
    previewMoney(current.id, -price);
    previewMoney(owner.id, price);
    prop.owner = current.id;
    qiangmaiState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}花${price}购买了${coloredName(owner.name, owner.color)}的${prop.name}` });
    socket.emit('showEndTurn');
  });

  socket.on('diaohuSelectTarget', ({ targetId }) => {
    if (!diaohuState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;
    diaohuState.targetId = targetId;
    pinqianState = {
      currentPlayerId: current.id,
      targetPlayerId: target.id,
      currentNumber: 0,
      targetNumber: 0,
      currentConfirmed: false,
      targetConfirmed: false,
      resultType: 'diaohu',
      rebound: false,
      hiddenMsg: ''
    };
    const currentSocket = io.sockets.sockets.get(current.id);
    const targetSocket = io.sockets.sockets.get(target.id);
    if (currentSocket) {
      currentSocket.emit('pinqianStart', {
        playerName: current.name,
        playerColor: current.color,
        targetName: target.name,
        targetColor: target.color,
        isCurrent: true
      });
    }
    if (targetSocket) {
      targetSocket.emit('pinqianStart', {
        playerName: current.name,
        playerColor: current.color,
        targetName: target.name,
        targetColor: target.color,
        isCurrent: false
      });
    }
  });

  socket.on('paozhuanSelectTarget', ({ targetId }) => {
    if (!paozhuanState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt) return;
    const targetProps = board.filter(s => s.isProperty && s.owner === target.id);
    if (targetProps.length === 0) return;
    paozhuanState.targetId = targetId;
    io.emit('paozhuanSelectProps', { 
      currentId: current.id, 
      targetId: target.id, 
      currentName: current.name, 
      currentColor: current.color, 
      targetName: target.name, 
      targetColor: target.color 
    });
  });

  socket.on('paozhuanPropSelected', ({ propId, ownerId }) => {
    if (!paozhuanState) return;
    const current = players[currentPlayerIndex];
    if (!current) return;
    if (socket.id !== paozhuanState.playerId && socket.id !== paozhuanState.targetId) return;
    if (socket.id === paozhuanState.playerId && ownerId !== paozhuanState.playerId) return;
    if (socket.id === paozhuanState.targetId && ownerId !== paozhuanState.targetId) return;
    if (ownerId === paozhuanState.playerId) {
      paozhuanState.currentPropId = propId;
    } else if (ownerId === paozhuanState.targetId) {
      paozhuanState.targetPropId = propId;
    }
    io.emit('paozhuanPropUpdate', { currentPropId: paozhuanState.currentPropId, targetPropId: paozhuanState.targetPropId });
    if (paozhuanState.currentPropId && paozhuanState.targetPropId) {
      const curProp = board.find(s => s.id === paozhuanState.currentPropId);
      const tgtProp = board.find(s => s.id === paozhuanState.targetPropId);
      if (curProp && tgtProp) {
        const tmpOwner = curProp.owner;
        curProp.owner = tgtProp.owner;
        tgtProp.owner = tmpOwner;
      }
      const curPlayer = players.find(p => p.id === paozhuanState.playerId);
      const tgtPlayer = players.find(p => p.id === paozhuanState.targetId);
      paozhuanState = null;
      io.emit('paozhuanEnd');
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(curPlayer.name, curPlayer.color)}用${curProp.name}与${coloredName(tgtPlayer.name, tgtPlayer.color)}的${tgtProp.name}互换` });
      const currentSocket = io.sockets.sockets.get(current.id);
      if (currentSocket) currentSocket.emit('showEndTurn');
    }
  });

  socket.on('yuanjiaoSelectTargetA', ({ targetId }) => {
    if (!yuanjiaoState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;
    yuanjiaoState.targetA = targetId;
    io.emit('yuanjiaoSelectTargetBStart', { playerId: current.id, excludeId: targetId });
  });

  socket.on('yuanjiaoSelectTargetB', ({ targetId }) => {
    if (!yuanjiaoState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id || target.id === yuanjiaoState.targetA) return;
    yuanjiaoState.targetB = targetId;
    pinqianState = {
      currentPlayerId: current.id,
      targetPlayerId: target.id,
      currentNumber: 0,
      targetNumber: 0,
      currentConfirmed: false,
      targetConfirmed: false,
      resultType: 'yuanjiao',
      rebound: false,
      hiddenMsg: ''
    };
    socket.emit('pinqianStart', { 
      playerName: current.name, 
      playerColor: current.color, 
      targetName: target.name, 
      targetColor: target.color, 
      isCurrent: true 
    });
    const targetSocket = io.sockets.sockets.get(target.id);
    if (targetSocket) {
      targetSocket.emit('pinqianStart', { 
        playerName: current.name, 
        playerColor: current.color, 
        targetName: target.name, 
        targetColor: target.color, 
        isCurrent: false 
      });
    }
  });

  socket.on('shunyiSelectPos', ({ posId }) => {
    if (!shunyiState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    const targetSpace = board.find(s => s.id === posId);
    if (!targetSpace) return;
    current.position = posId;
    shunyiState = null;
    io.emit('shunyiEnd');
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}瞬移到${targetSpace.name}` });
    socket.emit('showEndTurn');
  });

  socket.on('zhilijiemuStartQuiz', () => {
    if (!zhilijiemuState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    io.emit('hongkongStartQuiz', { 
      ownerId: current.id, 
      ownerName: current.name, 
      ownerColor: current.color,
      randomPlayerId: current.id,
      randomPlayerName: current.name,
      randomPlayerColor: current.color,
      isZhilijiemu: true
    });
  });

  socket.on('zhilijiemuEnd', () => {
    zhilijiemuState = null;
    const current = players[currentPlayerIndex];
    if (current) {
      socket.emit('showEndTurn');
    }
  });

  socket.on('zhongjinSelectPet', ({ petName }) => {
    if (!zhongjinState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const isFree = zhongjinState.free;
    const selectedPetInfo = getPetInfo(petName);
    const selectedPetName = selectedPetInfo ? selectedPetInfo.name : '宠物';
    
    if (isFree) {
      // 细胞技能：免费获得选中宠物，细胞宠物回库
      const cellPet = '19.png';
      if (!petPool.includes(cellPet)) {
        petPool.push(cellPet);
      }
      current.petImage = petName;
      current.originalPetImage = null;
      current.petFlipped = false;
      if (current.extraPets) {
        const idx = current.extraPets.indexOf(cellPet);
        if (idx > -1) {
          current.extraPets.splice(idx, 1);
        }
      }
    } else {
      previewMoney(current.id, -40);
      const petIndex = petPool.indexOf(petName);
      if (petIndex > -1) {
        petPool.splice(petIndex, 1);
      }
      if (current.petImage) {
        if (!current.extraPets) current.extraPets = [];
        current.extraPets.push(petName);
      } else {
        current.petImage = petName;
        current.originalPetImage = null;
      }
    }
    
    zhongjinState = null;
    io.emit('zhongjinEnd');
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: isFree
      ? `${coloredName(current.name, current.color)}的细胞进化为${selectedPetName}`
      : `${coloredName(current.name, current.color)}花40购买宠物` });
    if (!isFree) {
      socket.emit('showEndTurn');
    }
  });

  socket.on('zhongjinGetPets', () => {
    if (!zhongjinState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    if (!zhongjinState.free && current.money < 40) {
      io.emit('updateAreaE', { message: '金钱不足40' });
      socket.emit('showEndTurn');
      zhongjinState = null;
      return;
    }
    
    if (petPool.length < 2) {
      io.emit('updateAreaE', { message: '宠物库不足' });
      socket.emit('showEndTurn');
      zhongjinState = null;
      return;
    }
    
    const shuffled = [...petPool].sort(() => Math.random() - 0.5);
    const selectedPets = shuffled.slice(0, 2);
    // 包含宠物名字和说明
    const petsWithInfo = selectedPets.map(petImage => {
      const petInfo = getPetInfo(petImage);
      return {
        image: petImage,
        name: petInfo ? petInfo.name : '宠物',
        desc: petInfo ? petInfo.desc : ''
      };
    });
    socket.emit('zhongjinShowPets', { pets: petsWithInfo });
  });

  socket.on('baihuChoose', ({ amount }) => {
    if (!pendingBaihuState) return;
    const current = players.find(p => p.id === socket.id);
    if (!current) return;
    const { payerId, ownerId } = pendingBaihuState;
    if (socket.id === payerId) {
      pendingBaihuState.payerChoice = amount;
    } else if (socket.id === ownerId) {
      pendingBaihuState.ownerChoice = amount;
    } else {
      return;
    }
    socket.emit('baihuClearF');
    if (pendingBaihuState.payerChoice !== null && pendingBaihuState.ownerChoice !== null) {
      const state = pendingBaihuState;
      const payer = players.find(p => p.id === payerId);
      const owner = players.find(p => p.id === ownerId);
      if (state.payerChoice === state.ownerChoice) {
        const s = state.payerChoice;
        previewMoney(payerId, s);
        deductMoney(ownerId, s);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        if (checkBankruptcy(owner)) { pendingBaihuState = null; nextTurn(); return; }
        io.emit('updateAreaE', { message: `白虎猜对免交路费，地主${coloredName(state.ownerName, state.ownerColor)}给${coloredName(state.payerName, state.payerColor)}${s}` });
      } else {
        deductMoney(payerId, state.rent);
        previewMoney(ownerId, state.rent);
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        if (checkBankruptcy(payer)) { pendingBaihuState = null; nextTurn(); return; }
        io.emit('updateAreaE', { message: `白虎猜给${state.payerChoice}猜错，继续给地主${coloredName(state.ownerName, state.ownerColor)}路费${state.rent}` });
      }
      const curPayer = players.find(p => p.id === payerId);
      if (curPayer && !curPayer.bankrupt) {
        const payerSocket = io.sockets.sockets.get(payerId);
        if (payerSocket) payerSocket.emit('showEndTurn');
      }
      pendingBaihuState = null;
    }
  });

  socket.on('wanrenmiExecute', () => {
    if (!wanrenmiState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    

    const currentSpace = board.find(s => s.id === current.position);
    if (!currentSpace) return;
    
    // 排除放逐区的玩家：inJail=true或position===1
    const others = players.filter(p => p.id !== current.id && !p.bankrupt && !p.inJail && p.position !== 1);
    others.forEach(p => {
      console.log(`  - ${p.name} (位置: ${p.position})`);
    });
    
    if (others.length === 0) {
      io.emit('updateAreaE', { message: '万人迷：无人可拉' });
      socket.emit('showEndTurn');
      return;
    }
    
    others.forEach(p => {
      p.position = current.position;
    });
    
    wanrenmiState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `所有人到${currentSpace.name}` });
    socket.emit('showEndTurn');
  });

  socket.on('tongbuExecute', () => {
    if (!tongbuState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const diceValue = currentDiceValue;
    
    // 排除放逐区的玩家：inJail=true或position===1
    const others = players.filter(p => p.id !== current.id && !p.bankrupt && !p.inJail && p.position !== 1);
    
    if (others.length === 0) {
      io.emit('updateAreaE', { message: '同步：无人可同步' });
      socket.emit('showEndTurn');
      return;
    }
    
    others.forEach(p => {
        p.syncedDice = diceValue;
      p.syncedByName = current.name;
      p.syncedByColor = current.color;
    });
    
    tongbuState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('tongbuApplied', { playerId: current.id, playerName: current.name, playerColor: current.color, diceValue });
    socket.emit('showEndTurn');
  });

  socket.on('xianhaiSelectTarget', ({ targetId }) => {
    if (!xianhaiState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;

    const target = players.find(p => p.id === targetId);
    if (!target || target.bankrupt || target.id === current.id) return;

    const isCardUse = xianhaiState.userId !== undefined;

    if (!isCardUse) {
      if (current.money < 7) {
        io.emit('updateAreaE', { message: '金钱不足7' });
        socket.emit('showEndTurn');
        xianhaiState = null;
        return;
      }
    }

    xianhaiState = null;

    if (isCardUse) {
      // 卡片使用流程：直接送监狱，不扣钱
      withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
        sendToJail(finalTarget.id, `${hiddenMsg}${coloredName(current.name, current.color)}使用陷害卡令${coloredName(finalTarget.name, finalTarget.color)}进监狱`, () => {
          io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}使用陷害卡令${coloredName(finalTarget.name, finalTarget.color)}进监狱` });
        });
      }, () => {
        socket.emit('showEndTurn');
      }, (sourcePlayer) => {
        sendToJail(sourcePlayer.id, `反弹！${coloredName(current.name, current.color)}使用陷害卡令${coloredName(sourcePlayer.name, sourcePlayer.color)}进监狱`, () => {
          io.emit('updateAreaE', { message: `反弹！${coloredName(current.name, current.color)}使用陷害卡令${coloredName(sourcePlayer.name, sourcePlayer.color)}进监狱` });
        });
      });
    } else {
      // 机遇流程：给7令进监狱
      withHiddenCheck(current.id, targetId, (finalTarget, hiddenMsg) => {
        previewMoney(current.id, -7);
        previewMoney(finalTarget.id, 7);
        sendToJail(finalTarget.id, '陷害', () => {
          io.emit('updateAreaE', { message: `${hiddenMsg}${coloredName(current.name, current.color)}给${coloredName(finalTarget.name, finalTarget.color)}7令其进监狱` });
          socket.emit('showEndTurn');
        });
      }, () => {
        socket.emit('showEndTurn');
      }, (sourcePlayer) => {
        previewMoney(sourcePlayer.id, -7);
        previewMoney(current.id, 7);
        sendToJail(sourcePlayer.id, '陷害', () => {
          io.emit('updateAreaE', { message: `${coloredName(target.name, target.color)}使用隐藏卡将陷害反弹给${coloredName(sourcePlayer.name, sourcePlayer.color)}，${coloredName(current.name, current.color)}给${coloredName(sourcePlayer.name, sourcePlayer.color)}7令其进监狱` });
          socket.emit('showEndTurn');
        });
      });
    }
  });

  socket.on('chehuoSelectPos', ({ posId }) => {
    if (!chehuoState) return;
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    dayunState = { playerId: current.id, position: posId, active: true };
    
    chehuoState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, dayunState });
    io.emit('updateAreaE', { message: '大运车下回合经过的人-4休息1回合，到达的人-8进医院' });
    socket.emit('showEndTurn');
  });

  socket.on('swapPet', ({ petName }) => {
    const current = players.find(p => p.id === socket.id);
    if (!current) return;
    if (!current.extraPets || !current.extraPets.includes(petName)) return;
    
    const oldPet = current.petImage;
    
    current.extraPets = current.extraPets.filter(p => p !== petName);
    
    if (oldPet) {
      if (!current.extraPets) current.extraPets = [];
      current.extraPets.push(oldPet);
    }
    
    current.petImage = petName;
    
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
  });

  socket.on('auctionAdd', (value) => {
    if (!auctionState) return;
    const bidder = players.find(p => p.id === socket.id);
    if (!bidder) return;
    
    const activeIndex = auctionState.activePlayers.indexOf(socket.id);
    if (activeIndex === -1 || activeIndex !== auctionState.currentBidderIndex) return;
    
    if (auctionState.bids[socket.id] === undefined) {
      auctionState.bids[socket.id] = auctionState.roundStartBid || 0;
    }
    
    auctionState.bids[socket.id] += value;
    auctionState.currentBid = auctionState.bids[socket.id];
    auctionState.lastBidderId = socket.id;
    
    socket.emit('auctionUpdate', { 
      myBid: auctionState.bids[socket.id],
      currentBid: auctionState.currentBid,
      roundStartBid: auctionState.roundStartBid || 0
    });
  });

  socket.on('auctionClear', () => {
    if (!auctionState) return;
    const bidder = players.find(p => p.id === socket.id);
    if (!bidder) return;
    
    const activeIndex = auctionState.activePlayers.indexOf(socket.id);
    if (activeIndex === -1 || activeIndex !== auctionState.currentBidderIndex) return;
    
    auctionState.bids[socket.id] = auctionState.roundStartBid || 0;
    socket.emit('auctionUpdate', { 
      myBid: auctionState.bids[socket.id],
      currentBid: auctionState.bids[socket.id],
      roundStartBid: auctionState.roundStartBid || 0
    });
  });

  socket.on('auctionPass', () => {
    if (!auctionState) return;
    const bidder = players.find(p => p.id === socket.id);
    if (!bidder) return;
    
    const activeIndex = auctionState.activePlayers.indexOf(socket.id);
    if (activeIndex === -1 || activeIndex !== auctionState.currentBidderIndex) return;
    
    auctionState.passedPlayers.push(socket.id);
    socket.emit('auctionPassed');
    
    const remainingPlayers = auctionState.activePlayers.filter(id => !auctionState.passedPlayers.includes(id));
    
    if (remainingPlayers.length === 1 && auctionState.currentBid > 0) {
      const winnerId = remainingPlayers[0];
      const winner = players.find(p => p.id === winnerId);
      if (winner) {
        previewMoney(winner.id, -auctionState.currentBid);
        if (auctionState.sellerId) {
          const seller = players.find(p => p.id === auctionState.sellerId);
          if (seller) {
            previewMoney(seller.id, auctionState.currentBid);
          }
        }
        if (auctionState.isPetAuction) {
          if (auctionState.sellerId) {
            const seller = players.find(p => p.id === auctionState.sellerId);
            if (seller) {
              if (seller.petImage === auctionState.petImage) {
                if (seller.originalPetImage) {
                  seller.petImage = seller.originalPetImage;
                  seller.originalPetImage = null;
                } else {
                  // 检查保护宠物
                  if (!checkProtectedAsset(seller.id, 'pet')) {
                    seller.petImage = null;
                  }
                }
              }
            }
          } else {
            const petIndex = petPool.indexOf(auctionState.petImage);
            if (petIndex > -1) {
              petPool.splice(petIndex, 1);
            }
          }
          if (!winner.petImage) {
            winner.petImage = auctionState.petImage;
          } else {
            if (!winner.extraPets) winner.extraPets = [];
            winner.extraPets.push(auctionState.petImage);
          }
        } else if (auctionState.isPropertyAuction) {
          const prop = board.find(s => s.id === auctionState.propertyId);
          if (prop) {
            if (auctionState.sellerId) {
              const seller = players.find(p => p.id === auctionState.sellerId);
              if (seller && checkProtectedAsset(seller.id, 'property')) {
                prop.owner = seller.id;
                io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
                io.emit('auctionEnd', {
                  winnerName: null, bid: 0,
                  isPropertyAuction: true,
                  propertyName: prop.name,
                  sellerId: auctionState.sellerId,
                  sellerName: auctionState.sellerName,
                  sellerColor: auctionState.sellerColor,
                  protectedTriggered: true
                });
                const currentSocket = io.sockets.sockets.get(players[currentPlayerIndex]?.id);
                if (currentSocket) currentSocket.emit('showEndTurn');
                auctionState = null;
                return;
              }
            }
            prop.owner = winner.id;
          }
        } else if (auctionState.isDiamondAuction) {
          const seller = players.find(p => p.id === auctionState.sellerId);
          if (seller) seller.hasDiamond = false;
          winner.hasDiamond = true;
          diamondHolder = winner.id;
          diamondProgress = 0;
          diamondProgressPlayerId = winner.id;
          diamondProgressPlayerColor = winner.color;
          io.emit('diamondProgressUpdate', { playerId: winner.id, playerColor: winner.color, progress: 0 });
        } else if (auctionState.isCardAuction) {
          const seller = players.find(p => p.id === auctionState.sellerId);
          if (seller && seller.cards) {
            seller.cards.splice(auctionState.cardIndex, 1);
          }
          if (!winner.cards) winner.cards = [];
          addCardToPlayer(winner, auctionState.card);
        } else if (auctionState.card1 && auctionState.card2) {
          addCardToPlayer(winner, auctionState.card1);
          addCardToPlayer(winner, auctionState.card2);
        } else {
          addCardToPlayer(winner, auctionState.card);
        }

        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        const _petInfo3 = auctionState.petImage ? getPetInfo(auctionState.petImage) : null;
        io.emit('auctionEnd', {
          winnerName: winner.name,
          winnerId: winner.id,
          winnerColor: winner.color,
          bid: auctionState.currentBid,
          card1: auctionState.card1 || auctionState.card,
          card2: auctionState.card2 || auctionState.playerCard,
          isPetAuction: auctionState.isPetAuction || false,
          isPropertyAuction: auctionState.isPropertyAuction || false,
          isDiamondAuction: auctionState.isDiamondAuction || false,
          isCardAuction: auctionState.isCardAuction || false,
          petImage: auctionState.petImage || null,
          petName: _petInfo3 ? _petInfo3.name : '',
          propertyName: auctionState.isPropertyAuction ? (board.find(s => s.id === auctionState.propertyId)?.name || '') : '',
          assetName: auctionState.assetName || '',
          sellerId: auctionState.sellerId || null,
          sellerName: auctionState.sellerName || '',
          sellerColor: auctionState.sellerColor || ''
        });
        
        const currentSocket = io.sockets.sockets.get(players[currentPlayerIndex]?.id);
        if (currentSocket) {
          currentSocket.emit('showEndTurn');
        }
        
        auctionState = null;
      }
    } else if (remainingPlayers.length === 0) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('auctionEnd', { winnerName: null, bid: 0, card: auctionState.card });
      const currentSocket = io.sockets.sockets.get(players[currentPlayerIndex]?.id);
      if (currentSocket) {
        currentSocket.emit('showEndTurn');
      }
      auctionState = null;
    } else {
      let nextIndex = (auctionState.currentBidderIndex + 1) % auctionState.activePlayers.length;
      while (auctionState.passedPlayers.includes(auctionState.activePlayers[nextIndex])) {
        nextIndex = (nextIndex + 1) % auctionState.activePlayers.length;
      }
      auctionState.currentBidderIndex = nextIndex;
      
      const nextBidderId = auctionState.activePlayers[nextIndex];
      auctionState.bids[nextBidderId] = auctionState.roundStartBid || 0;
      
      const nextBidder = players.find(p => p.id === nextBidderId);
      const lastBidder = auctionState.lastBidderId ? players.find(p => p.id === auctionState.lastBidderId) : null;
      if (nextBidder) {
        const _petInfo = auctionState.petImage ? getPetInfo(auctionState.petImage) : null;
        io.emit('auctionNextBidder', {
          bidderId: nextBidder.id,
          bidderName: nextBidder.name,
          bidderColor: nextBidder.color,
          currentBid: auctionState.currentBid,
          card1: auctionState.card1 || auctionState.card,
          card2: auctionState.card2 || auctionState.playerCard,
          roundStartBid: auctionState.roundStartBid || 0,
          lastBidderName: lastBidder?.name,
          lastBidderColor: lastBidder?.color,
          isPetAuction: auctionState.isPetAuction || false,
          isPropertyAuction: auctionState.isPropertyAuction || false,
          isDiamondAuction: auctionState.isDiamondAuction || false,
          isCardAuction: auctionState.isCardAuction || false,
          petImage: auctionState.petImage || null,
          petName: _petInfo ? _petInfo.name : '',
          petDesc: _petInfo ? _petInfo.desc : '',
          property: auctionState.isPropertyAuction ? (() => { const p = board.find(s => s.id === auctionState.propertyId); return p ? { id: p.id, name: p.name, price: p.price } : null; })() : null,
          assetName: auctionState.assetName || '',
          sellerId: auctionState.sellerId || null,
          sellerName: auctionState.sellerName || '',
          sellerColor: auctionState.sellerColor || ''
        });
      }
    }
  });

  socket.on('auctionConfirm', () => {
    if (!auctionState) return;
    const bidder = players.find(p => p.id === socket.id);
    if (!bidder) return;
    
    const activeIndex = auctionState.activePlayers.indexOf(socket.id);
    if (activeIndex === -1 || activeIndex !== auctionState.currentBidderIndex) return;
    
    if (!auctionState.bids[socket.id] || auctionState.bids[socket.id] <= 0) return;
    
    auctionState.roundStartBid = auctionState.bids[socket.id];
    auctionState.lastBidderId = socket.id;
    
    io.emit('auctionBidderConfirmed', { 
      bidderName: bidder.name, 
      bidderColor: bidder.color,
      bid: auctionState.bids[socket.id] 
    });
    
    // 卖家确认底价后自动弃权（不参与后续出价）
    if (auctionState.sellerId && socket.id === auctionState.sellerId) {
      auctionState.passedPlayers.push(socket.id);
      socket.emit('auctionPassed');
    }
    
    const remainingPlayers = auctionState.activePlayers.filter(id => !auctionState.passedPlayers.includes(id));
    
    if (remainingPlayers.length === 1 && remainingPlayers[0] === socket.id) {
      const winner = players.find(p => p.id === socket.id);
      if (winner) {
        previewMoney(winner.id, -auctionState.bids[socket.id]);
        if (auctionState.sellerId) {
          const seller = players.find(p => p.id === auctionState.sellerId);
          if (seller) {
            previewMoney(seller.id, auctionState.bids[socket.id]);
          }
        }
        if (auctionState.isPetAuction) {
          if (auctionState.sellerId) {
            const seller = players.find(p => p.id === auctionState.sellerId);
            if (seller) {
              if (seller.petImage === auctionState.petImage) {
                if (seller.originalPetImage) {
                  seller.petImage = seller.originalPetImage;
                  seller.originalPetImage = null;
                } else {
                  // 检查保护宠物
                  if (!checkProtectedAsset(seller.id, 'pet')) {
                    seller.petImage = null;
                  }
                }
              }
            }
          } else {
            const petSpace = board.find(s => s.type === 'pet');
            if (petSpace) petSpace.owner = winner.id;
          }
          if (!winner.petImage) {
            winner.petImage = auctionState.petImage;
          } else {
            if (!winner.extraPets) winner.extraPets = [];
            winner.extraPets.push(auctionState.petImage);
          }
        } else if (auctionState.isPropertyAuction) {
          const prop = board.find(s => s.id === auctionState.propertyId);
          if (prop) {
            if (auctionState.sellerId) {
              const seller = players.find(p => p.id === auctionState.sellerId);
              if (seller && checkProtectedAsset(seller.id, 'property')) {
                prop.owner = seller.id;
                io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
                io.emit('auctionEnd', {
                  winnerName: null, bid: 0,
                  isPropertyAuction: true,
                  propertyName: prop.name,
                  sellerId: auctionState.sellerId,
                  sellerName: auctionState.sellerName,
                  sellerColor: auctionState.sellerColor,
                  protectedTriggered: true
                });
                const currentSocket = io.sockets.sockets.get(players[currentPlayerIndex]?.id);
                if (currentSocket) currentSocket.emit('showEndTurn');
                auctionState = null;
                return;
              }
            }
            prop.owner = winner.id;
          }
        } else if (auctionState.isDiamondAuction) {
          const seller = players.find(p => p.id === auctionState.sellerId);
          if (seller) seller.hasDiamond = false;
          winner.hasDiamond = true;
          diamondHolder = winner.id;
          diamondProgress = 0;
          diamondProgressPlayerId = winner.id;
          diamondProgressPlayerColor = winner.color;
          io.emit('diamondProgressUpdate', { playerId: winner.id, playerColor: winner.color, progress: 0 });
        } else if (auctionState.isCardAuction) {
          const seller = players.find(p => p.id === auctionState.sellerId);
          if (seller && seller.cards && auctionState.cardIndex != null) {
            seller.cards.splice(auctionState.cardIndex, 1);
          }
          if (auctionState.card) {
            addCardToPlayer(winner, auctionState.card);
          }
        } else if (auctionState.card1 && auctionState.card2) {
          addCardToPlayer(winner, auctionState.card1);
          addCardToPlayer(winner, auctionState.card2);
        } else {
          addCardToPlayer(winner, auctionState.card);
        }

        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
        const _petInfo4 = auctionState.petImage ? getPetInfo(auctionState.petImage) : null;
        io.emit('auctionEnd', {
          winnerName: winner.name,
          winnerId: winner.id,
          winnerColor: winner.color,
          bid: auctionState.bids[socket.id],
          card1: auctionState.card1 || auctionState.card,
          card2: auctionState.card2 || auctionState.playerCard,
          isPetAuction: auctionState.isPetAuction || false,
          isPropertyAuction: auctionState.isPropertyAuction || false,
          isDiamondAuction: auctionState.isDiamondAuction || false,
          isCardAuction: auctionState.isCardAuction || false,
          petImage: auctionState.petImage || null,
          petName: _petInfo4 ? _petInfo4.name : '',
          propertyName: auctionState.isPropertyAuction ? (board.find(s => s.id === auctionState.propertyId)?.name || '') : '',
          assetName: auctionState.assetName || '',
          sellerId: auctionState.sellerId || null,
          sellerName: auctionState.sellerName || '',
          sellerColor: auctionState.sellerColor || ''
        });
        
        const currentSocket = io.sockets.sockets.get(players[currentPlayerIndex]?.id);
        if (currentSocket) {
          currentSocket.emit('showEndTurn');
        }
        
        auctionState = null;
      }
      return;
    }
    
    let nextIndex = (auctionState.currentBidderIndex + 1) % auctionState.activePlayers.length;
    while (auctionState.passedPlayers.includes(auctionState.activePlayers[nextIndex])) {
      nextIndex = (nextIndex + 1) % auctionState.activePlayers.length;
    }
    auctionState.currentBidderIndex = nextIndex;
    
    const nextBidderId = auctionState.activePlayers[nextIndex];
    auctionState.bids[nextBidderId] = auctionState.roundStartBid;
    
    const nextBidder = players.find(p => p.id === nextBidderId);
    const lastBidder = auctionState.lastBidderId ? players.find(p => p.id === auctionState.lastBidderId) : null;
    if (nextBidder) {
      const _petInfo2 = auctionState.petImage ? getPetInfo(auctionState.petImage) : null;
      io.emit('auctionNextBidder', {
        bidderId: nextBidder.id,
        bidderName: nextBidder.name,
        bidderColor: nextBidder.color,
        currentBid: auctionState.currentBid,
          card1: auctionState.card1 || auctionState.card,
          card2: auctionState.card2,
        roundStartBid: auctionState.roundStartBid,
        lastBidderName: lastBidder?.name,
        lastBidderColor: lastBidder?.color,
        isPetAuction: auctionState.isPetAuction || false,
        isPropertyAuction: auctionState.isPropertyAuction || false,
        isDiamondAuction: auctionState.isDiamondAuction || false,
        isCardAuction: auctionState.isCardAuction || false,
        petImage: auctionState.petImage || null,
        petName: _petInfo2 ? _petInfo2.name : '',
        petDesc: _petInfo2 ? _petInfo2.desc : '',
        property: auctionState.isPropertyAuction ? (() => { const p = board.find(s => s.id === auctionState.propertyId); return p ? { id: p.id, name: p.name, price: p.price } : null; })() : null,
        assetName: auctionState.assetName || '',
        sellerId: auctionState.sellerId || null,
        sellerName: auctionState.sellerName || '',
        sellerColor: auctionState.sellerColor || ''
      });
    }
  });

  socket.on('playEmoji', ({ src }) => {
    io.emit('showEmoji', { src, playerId: socket.id });
  });

  socket.on('taiwanBuild', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const space = board.find(s => s.id === current.position);
    if (!space || space.name !== '台湾' || space.owner !== current.id) return;
    
    const buildCost = Math.round(space.price / 4);
    if (current.money >= buildCost && space.houseLevel < 4) {
      previewMoney(current.id, -buildCost);
      space.houseLevel = (space.houseLevel || 0) + 1;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      socket.emit('taiwanAfterBuild', { spaceName: space.name, houseLevel: space.houseLevel });
    }
  });

  socket.on('taiwanSkipBuild', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    socket.emit('taiwanPokerChoice');
  });

  let hongkongState = null;

  socket.on('hongkongBuild', ({ randomPlayerId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const space = board.find(s => s.id === current.position);
      if (!space || space.name !== '香港') return;
    
    const buildCost = Math.round(space.price / 4);
    if (current.money >= buildCost && space.houseLevel < 4) {
      previewMoney(current.id, -buildCost);
      space.houseLevel = (space.houseLevel || 0) + 1;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      
      const randomPlayer = players.find(p => p.id === randomPlayerId);
      io.emit('hongkongAfterBuild', { 
        spaceName: space.name, 
        houseLevel: space.houseLevel,
        ownerId: current.id,
        ownerName: current.name,
        ownerColor: current.color,
        randomPlayerName: randomPlayer?.name,
        randomPlayerColor: randomPlayer?.color,
        randomPlayerId: randomPlayerId,
        isOwner: true
      });
      const randomSocket = io.sockets.sockets.get(randomPlayerId);
      if (randomSocket) {
        randomSocket.emit('hongkongAfterBuild', { 
          spaceName: space.name, 
          houseLevel: space.houseLevel,
          ownerId: current.id,
          ownerName: current.name,
          ownerColor: current.color,
          randomPlayerName: randomPlayer?.name,
          randomPlayerColor: randomPlayer?.color,
          randomPlayerId: randomPlayerId,
          isOwner: current.id === randomPlayerId
        });
      }
    }
  });

  socket.on('hongkongSkipBuild', ({ randomPlayerId }) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const space = board.find(s => s.id === current.position);
      if (!space || space.name !== '香港') return;
    
    const randomPlayer = players.find(p => p.id === randomPlayerId);
    io.emit('hongkongAfterSkip', { 
      ownerId: current.id,
      ownerName: current.name,
      ownerColor: current.color,
      randomPlayerName: randomPlayer?.name,
      randomPlayerColor: randomPlayer?.color,
      randomPlayerId: randomPlayerId,
      isOwner: true
    });
    const randomSocket = io.sockets.sockets.get(randomPlayerId);
    if (randomSocket) {
      randomSocket.emit('hongkongAfterSkip', { 
        ownerId: current.id,
        ownerName: current.name,
        ownerColor: current.color,
        randomPlayerName: randomPlayer?.name,
        randomPlayerColor: randomPlayer?.color,
        randomPlayerId: randomPlayerId,
        isOwner: current.id === randomPlayerId
      });
    }
  });

  socket.on('hongkongQuizResult', ({ ownerId, randomPlayerId, correctCount, isTimeout, isZhilijiemu }) => {
    const owner = players.find(p => p.id === ownerId);
    const randomPlayer = players.find(p => p.id === randomPlayerId);
    const isSamePerson = ownerId === randomPlayerId;
    
    let msg = '';
    if (correctCount === 20) {
      if (owner) {
        previewMoney(owner.id, 40);
      }
      if (!isSamePerson && !isZhilijiemu && randomPlayer) {
        previewMoney(randomPlayer.id, 40);
      }
      if (isSamePerson || isZhilijiemu) {
        msg = `全部答对，${coloredName(owner?.name, owner?.color)}+40`;
      } else {
        msg = `全部答对，${coloredName(owner?.name, owner?.color)}和${coloredName(randomPlayer?.name, randomPlayer?.color)}各+40`;
      }
    } else if (correctCount < 6) {
      const penalty = 10 - correctCount;
      if (owner) {
        previewMoney(owner.id, -penalty);
      }
      if (!isSamePerson && !isZhilijiemu && randomPlayer) {
        previewMoney(randomPlayer.id, -penalty);
      }
      if (isSamePerson || isZhilijiemu) {
        msg = `答对${correctCount}题，<6，${coloredName(owner?.name, owner?.color)}-${penalty}`;
      } else {
        msg = `答对${correctCount}题，<6，${coloredName(owner?.name, owner?.color)}和${coloredName(randomPlayer?.name, randomPlayer?.color)}各-${penalty}`;
      }
    } else {
      const reward = correctCount;
      if (owner) {
        previewMoney(owner.id, reward);
      }
      if (!isSamePerson && !isZhilijiemu && randomPlayer) {
        previewMoney(randomPlayer.id, reward);
      }
      if (isSamePerson || isZhilijiemu) {
        msg = `答对${correctCount}题，${coloredName(owner?.name, owner?.color)}+${reward}`;
      } else {
        msg = `答对${correctCount}题，${coloredName(owner?.name, owner?.color)}和${coloredName(randomPlayer?.name, randomPlayer?.color)}各+${reward}`;
      }
    }
    
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('hongkongQuizEnd', { message: msg, ownerId, randomPlayerId, isZhilijiemu });
  });

  socket.on('hongkongSkipQuiz', ({ ownerId, randomPlayerId }) => {
    const owner = players.find(p => p.id === ownerId);
    const msg = `${coloredName(owner?.name, owner?.color)}放弃了答题`;

    io.emit('hongkongSkipQuizResult', { message: msg, ownerId });
  });

  socket.on('hongkongStartQuiz', ({ ownerId, randomPlayerId }) => {
    const owner = players.find(p => p.id === ownerId);
    const randomPlayer = players.find(p => p.id === randomPlayerId);
    io.emit('hongkongStartQuiz', { 
      ownerId, 
      ownerName: owner?.name, 
      ownerColor: owner?.color,
      randomPlayerName: randomPlayer?.name, 
      randomPlayerColor: randomPlayer?.color,
      randomPlayerId 
    });
  });

  socket.on('closeQuizPanel', () => {
    io.emit('closeQuizPanel');
  });

  socket.on('quizStartGame', (data) => {
    io.emit('quizStartGame', data);
  });

  socket.on('quizNextQuestion', (data) => {
    io.emit('quizNextQuestion', data);
  });

  socket.on('quizAnswer', (data) => {
    io.emit('quizAnswer', data);
  });

  socket.on('macauBuild', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const space = board.find(s => s.id === current.position);
      if (!space || space.name !== '澳门' || space.owner !== current.id) return;
    
    const buildCost = Math.round(space.price / 4);
    if (current.money >= buildCost && space.houseLevel < 4) {
      previewMoney(current.id, -buildCost);
      space.houseLevel = (space.houseLevel || 0) + 1;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      socket.emit('macauAfterBuild', { 
        spaceName: space.name, 
        houseLevel: space.houseLevel,
        ownerName: current.name,
        ownerColor: current.color
      });
    }
  });

  socket.on('macauSkipBuild', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    socket.emit('macauAfterSkip', { ownerName: current.name, ownerColor: current.color });
  });

  socket.on('macauStartGame', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    macauState = {
      ownerId: current.id,
      ownerName: current.name,
      ownerColor: current.color,
      players: {},
      result: null,
      allConfirmed: false,
      confirmedCount: 0,
      totalPlayers: 0
    };
    
    const activePlayers = players.filter(p => !p.bankrupt);
    macauState.totalPlayers = activePlayers.length;
    activePlayers.forEach(p => {
      macauState.players[p.id] = {
        id: p.id,
        name: p.name,
        color: p.color,
        bet: 0,
        choice: null,
        confirmed: false
      };
    });
    
    io.emit('macauGameStart', { 
      ownerId: macauState.ownerId,
      ownerName: macauState.ownerName,
      ownerColor: macauState.ownerColor,
      players: macauState.players
    });
  });

  socket.on('macauSkipGame', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    macauState = null;
    io.emit('macauGameEnd');
    socket.emit('showEndTurn');
  });

  socket.on('macauBet', ({ bet }) => {
    if (!macauState) return;
    const playerData = macauState.players[socket.id];
    if (!playerData) return;
    playerData.bet = Math.min(20, Math.max(0, bet));
    io.emit('macauPlayerUpdate', { playerId: socket.id, bet: playerData.bet });
  });

  socket.on('macauChoice', ({ choice }) => {
    if (!macauState) return;
    const playerData = macauState.players[socket.id];
    if (!playerData) return;
    playerData.choice = choice;
    io.emit('macauPlayerUpdate', { playerId: socket.id, choice: playerData.choice });
  });

  socket.on('macauConfirm', () => {
    if (!macauState) return;
    const playerData = macauState.players[socket.id];
    if (!playerData || playerData.confirmed) return;
    playerData.confirmed = true;
    macauState.confirmedCount++;
    
    io.emit('macauPlayerUpdate', { playerId: socket.id, confirmed: playerData.confirmed });
    
    if (macauState.confirmedCount >= macauState.totalPlayers) {
      macauState.allConfirmed = true;
      io.emit('macauAllConfirmed', { allConfirmed: true });
      doMacauRoll();
    }
  });

  function doMacauRoll() {
    if (!macauState || !macauState.allConfirmed) return;
    
    const result = Math.floor(Math.random() * 6) + 1;
    macauState.result = result;
    
    const isSmall = result <= 3;
    const results = [];
    
    Object.values(macauState.players).forEach(p => {
      if (p.choice && p.bet > 0) {
        const player = players.find(pl => pl.id === p.id);
        if (player) {
          const win = (isSmall && p.choice === 'small') || (!isSmall && p.choice === 'big');
          if (win) {
            previewMoney(player.id, p.bet);
            results.push({ name: p.name, color: p.color, change: '+' + p.bet });
          } else {
            previewMoney(player.id, -p.bet);
            results.push({ name: p.name, color: p.color, change: '-' + p.bet });
          }
        }
      }
    });
    
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('macauResult', { result, results });
  }

  socket.on('macauRoll', () => {
    doMacauRoll();
  });

  socket.on('macauClose', () => {
    macauState = null;
    io.emit('macauGameEnd');
  });

  socket.on('texasRandomTwo', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const activePlayers = players.filter(p => !p.bankrupt);
    if (activePlayers.length < 2) {
      socket.emit('error', '玩家不足');
      return;
    }
    
    const shuffled = activePlayers.sort(() => Math.random() - 0.5);
    const player1 = shuffled[0];
    const player2 = shuffled[1];
    
    startTexasHoldem(player1.id, player2.id);
  });

  socket.on('texasSelectPlayer', (targetId) => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    const activePlayers = players.filter(p => !p.bankrupt && p.id !== targetId);
    if (activePlayers.length < 1) {
      socket.emit('error', '玩家不足');
      return;
    }
    
    const randomPlayer = activePlayers[Math.floor(Math.random() * activePlayers.length)];
    startTexasHoldem(targetId, randomPlayer.id);
  });

  socket.on('texasSkip', () => {
    const current = players[currentPlayerIndex];
    if (!current || current.id !== socket.id) return;
    
    io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}æ”¾å¼ƒäº†å¾·å·žæ‰‘å…‹` });
    socket.emit('showEndTurn');
  });

  socket.on('texasDiscard', (cardIndices) => {
    if (!texasHoldemState) return;
    const playerState = texasHoldemState.players[socket.id];
    if (!playerState || playerState.discardCount >= 3) return;
    
    const newCards = [];
    const remainingCards = playerState.cards.filter((_, i) => !cardIndices.includes(i));
    
    while (remainingCards.length + newCards.length < 8 && playerState.deck.length > 0) {
      newCards.push(playerState.deck.pop());
    }
    
    playerState.cards = [...remainingCards, ...newCards];
    playerState.discardCount++;
    playerState.selectedCards = [];
    
    io.to(socket.id).emit('texasUpdateCards', { 
      cards: playerState.cards, 
      discardCount: playerState.discardCount 
    });
    
    const player = players.find(pl => pl.id === socket.id);
    const playerIds = Object.keys(texasHoldemState.players);
    const isPlayer1 = socket.id === playerIds[0];
    
    Object.keys(texasWatchers).forEach(watcherId => {
      io.to(watcherId).emit('texasWatchUpdate', {
        playerId: socket.id,
        isPlayer1,
        hands: playerState.playedHands,
        cards: playerState.cards,
        name: player?.name,
        color: player?.color,
        roundCount: playerState.roundCount,
        discardCount: playerState.discardCount
      });
    });
    
    Object.entries(texasWatchers).forEach(([watcherId, targetId]) => {
      if (targetId === socket.id) {
        io.to(watcherId).emit('texasWatchResult', {
          hands: playerState.playedHands,
          name: player?.name,
          color: player?.color,
          cards: playerState.cards,
          discardCount: playerState.discardCount,
          roundCount: playerState.roundCount
        });
      }
    });
  });

  socket.on('texasPlay', (cardIndices) => {
    if (texasFinalResults[socket.id]) {
      socket.emit('texasFinalResult', texasFinalResults[socket.id]);
      return;
    }
    if (!texasHoldemState) return;
    const playerState = texasHoldemState.players[socket.id];
    if (!playerState || cardIndices.length !== 5) return;
    
    const playedCards = cardIndices.map(i => playerState.cards[i]);
    const result = calculatePokerHand(playedCards, socket.id);
    
    playerState.playedHands.push(result);
    playerState.roundCount++;
    playerState.selectedCards = [];
    
    const remainingCards = playerState.cards.filter((_, i) => !cardIndices.includes(i));
    const newCards = [];
    while (remainingCards.length + newCards.length < 8 && playerState.deck.length > 0) {
      newCards.push(playerState.deck.pop());
    }
    playerState.cards = [...remainingCards, ...newCards];
    
    io.to(socket.id).emit('texasShowResult', { 
      result, 
      roundCount: playerState.roundCount,
      cards: playerState.cards
    });
    
    const player = players.find(pl => pl.id === socket.id);
    const playerIds = Object.keys(texasHoldemState.players);
    const isPlayer1 = socket.id === playerIds[0];
    
    Object.keys(texasWatchers).forEach(watcherId => {
      io.to(watcherId).emit('texasWatchUpdate', {
        playerId: socket.id,
        isPlayer1,
        hands: playerState.playedHands,
        cards: playerState.cards,
        name: player?.name,
        color: player?.color,
        roundCount: playerState.roundCount,
        discardCount: playerState.discardCount
      });
    });
    
    Object.entries(texasWatchers).forEach(([watcherId, targetId]) => {
      if (targetId === socket.id) {
        io.to(watcherId).emit('texasWatchResult', {
          hands: playerState.playedHands,
          name: player?.name,
          color: player?.color,
          cards: playerState.cards,
          discardCount: playerState.discardCount,
          roundCount: playerState.roundCount
        });
      }
    });
    
    const opponentId = Object.keys(texasHoldemState.players).find(id => id !== socket.id);
    
    if (opponentId && texasHoldemState) {
      const opponentState = texasHoldemState.players[opponentId];
      if (opponentState) {
        const minRounds = Math.min(playerState.roundCount, opponentState.roundCount);
        while (texasHoldemState && texasHoldemState.results.length < minRounds) {
          checkTexasRoundResult(texasHoldemState.results.length);
        }
      }
    }
    
    if (playerState.roundCount >= 3 && !texasFinalResults[socket.id]) {
      io.to(socket.id).emit('texasWaiting');
    }
  });

  socket.on('texasWatch', (targetId) => {
    if (!texasHoldemState || !texasHoldemState.players[targetId]) return;
    const playerState = texasHoldemState.players[targetId];
    texasWatchers[socket.id] = targetId;
    const player = players.find(p => p.id === targetId);
    socket.emit('texasWatchResult', {
      hands: playerState.playedHands,
      name: player?.name,
      color: player?.color,
      cards: playerState.cards,
      discardCount: playerState.discardCount,
      roundCount: playerState.roundCount
    });
  });

  socket.on('texasClose', () => {
    texasClosedPlayers.add(socket.id);
    const playerIds = Object.keys(texasFinalResults);
    if (playerIds.length >= 2 && playerIds.every(id => texasClosedPlayers.has(id))) {
      const currentPlayerId = players[currentPlayerIndex]?.id;
      playerIds.forEach(id => {
        io.to(id).emit('texasPanelClose', { showEndTurn: id === currentPlayerId });
      });
      Object.keys(texasWatchers).forEach(watcherId => {
        io.to(watcherId).emit('texasWatchClose');
      });
      texasClosedPlayers.clear();
      texasWatchers = {};
      initPukepaiDeck();
      shufflePukepaiDeck();
    }
  });

  function startTexasHoldem(player1Id, player2Id) {
    const createDeck = () => Array.from({length: 52}, (_, i) => i).sort(() => Math.random() - 0.5);
    const deck1 = createDeck();
    const deck2 = createDeck();
    
    texasWatchers = {};
    texasFinalResults = {};
    texasClosedPlayers.clear();
    texasHoldemState = {
      players: {
        [player1Id]: {
          cards: deck1.slice(0, 8),
          deck: deck1.slice(8),
          selectedCards: [],
          discardCount: 0,
          playedHands: [],
          roundCount: 0
        },
        [player2Id]: {
          cards: deck2.slice(0, 8),
          deck: deck2.slice(8),
          selectedCards: [],
          discardCount: 0,
          playedHands: [],
          roundCount: 0
        }
      },
      results: []
    };
    
    io.to(player1Id).emit('texasStart', { cards: texasHoldemState.players[player1Id].cards });
    io.to(player2Id).emit('texasStart', { cards: texasHoldemState.players[player2Id].cards });
    
    const player1 = players.find(p => p.id === player1Id);
    const player2 = players.find(p => p.id === player2Id);
    io.emit('updateAreaE', { message: `${coloredName(player1?.name, player1?.color)} vs ${coloredName(player2?.name, player2?.color)}` });
    
    players.forEach(p => {
      if (p.id !== player1Id && p.id !== player2Id) {
        texasWatchers[p.id] = player1Id;
      }
    });
    
    io.emit('texasPlayers', { player1: player1?.name, player2: player2?.name, player1Color: player1?.color, player2Color: player2?.color, player1Id, player2Id, player1Cards: texasHoldemState.players[player1Id].cards, player2Cards: texasHoldemState.players[player2Id].cards });
  }

  function calculatePokerHand(cardValues, playerId) {
    const values = cardValues.map(i => Math.floor(i / 4) + 1);
    const suits = cardValues.map(i => i % 4);
    
    const valueCounts = {};
    values.forEach(v => valueCounts[v] = (valueCounts[v] || 0) + 1);
    const counts = Object.values(valueCounts).sort((a, b) => b - a);
    
    const isFlush = suits.every(s => s === suits[0]);
    const uniqueValues = [...new Set(values)].sort((a, b) => a - b);
    const isStraight = uniqueValues.length === 5 && uniqueValues[4] - uniqueValues[0] === 4;
    
    const sumValues = values.reduce((a, b) => a + b, 0);
    
    let type, score;
    const player = players.find(p => p.id === playerId);
    
    if (isFlush && isStraight) {
      type = '同花顺';
      score = 8 * (100 + sumValues + 5);
      if (player) {
        previewMoney(player.id, 50);
      }
    } else if (counts[0] === 4) {
      type = '四条';
      score = 7 * (60 + sumValues + 5);
      if (player) {
        previewMoney(player.id, 5);
      }
    } else if (counts[0] === 3 && counts[1] === 2) {
      type = '葫芦';
      score = 6 * (40 + sumValues + 5);
    } else if (isFlush) {
      type = '同花';
      score = 5 * (35 + sumValues + 5);
    } else if (isStraight) {
      type = '顺子';
      score = 4 * (30 + sumValues + 5);
    } else if (counts[0] === 3) {
      type = '三条';
      score = 3 * (30 + sumValues + 5);
    } else if (counts[0] === 2 && counts[1] === 2) {
      type = '两对';
      score = 3 * (20 + sumValues + 5);
    } else if (counts[0] === 2) {
      type = '对子';
      score = 2 * (10 + sumValues + 5);
    } else {
      type = '高牌';
      score = 1 * (5 + sumValues + 5);
    }
    
    return { type, score, cards: cardValues };
  }

  function checkTexasRoundResult(roundIndex) {
    if (!texasHoldemState) return;
    const playerIds = Object.keys(texasHoldemState.players);
    const p1Hand = texasHoldemState.players[playerIds[0]].playedHands[roundIndex];
    const p2Hand = texasHoldemState.players[playerIds[1]].playedHands[roundIndex];
    
    let result;
    if (p1Hand.score > p2Hand.score) result = 'win';
    else if (p1Hand.score < p2Hand.score) result = 'lose';
    else result = 'draw';
    
    texasHoldemState.results.push(result);
    
    io.to(playerIds[0]).emit('texasRoundResult', { 
      myHand: p1Hand, 
      opponentHand: p2Hand, 
      result 
    });
    io.to(playerIds[1]).emit('texasRoundResult', { 
      myHand: p2Hand, 
      opponentHand: p1Hand, 
      result: result === 'win' ? 'lose' : result === 'lose' ? 'win' : 'draw' 
    });
    
    const player1 = players.find(p => p.id === playerIds[0]);
    const player2 = players.find(p => p.id === playerIds[1]);
    Object.entries(texasWatchers).forEach(([watcherId]) => {
      io.to(watcherId).emit('texasWatchRoundResult', {
        roundIndex,
        p1Hand,
        p2Hand,
        result,
        p1Name: player1?.name,
        p1Color: player1?.color,
        p2Name: player2?.name,
        p2Color: player2?.color
      });
    });
    
    if (texasHoldemState.results.length >= 3) {
      endTexasHoldem(playerIds);
    }
  }

  function endTexasHoldem(playerIds) {
    const results = texasHoldemState.results;
    const p1Wins = results.filter(r => r === 'win').length;
    const p1Loses = results.filter(r => r === 'lose').length;
    const draws = results.filter(r => r === 'draw').length;
    
    const player1 = players.find(p => p.id === playerIds[0]);
    const player2 = players.find(p => p.id === playerIds[1]);
    
    const p1Hands = texasHoldemState.players[playerIds[0]].playedHands;
    const p2Hands = texasHoldemState.players[playerIds[1]].playedHands;
    
    const resultTexts = results.map(r => r === 'win' ? '胜' : r === 'lose' ? '负' : '平');
    
    const p1Result = { myHands: p1Hands, opponentHands: p2Hands, results: resultTexts, myName: player1?.name, myColor: player1?.color, opponentName: player2?.name, opponentColor: player2?.color };
    const p2Result = { myHands: p2Hands, opponentHands: p1Hands, results: resultTexts.map(r => r === '胜' ? '负' : r === '负' ? '胜' : '平'), myName: player2?.name, myColor: player2?.color, opponentName: player1?.name, opponentColor: player1?.color };

    
    texasFinalResults[playerIds[0]] = p1Result;
    texasFinalResults[playerIds[1]] = p2Result;
    
    io.to(playerIds[0]).emit('texasFinalResult', p1Result);
    io.to(playerIds[1]).emit('texasFinalResult', p2Result);
    
    const watchResult = { 
      player1Name: player1?.name, 
      player1Color: player1?.color,
      player2Name: player2?.name,
      player2Color: player2?.color,
      p1Hands, p2Hands, results: resultTexts 
    };
    Object.entries(texasWatchers).forEach(([watcherId]) => {
      io.to(watcherId).emit('texasWatchFinalResult', watchResult);
    });
    
    let winner = null;
    let loser = null;
    
    const p1TotalScore = p1Hands.reduce((sum, h) => sum + (h?.score || 0), 0);
    const p2TotalScore = p2Hands.reduce((sum, h) => sum + (h?.score || 0), 0);
    
    if (p1TotalScore > p2TotalScore) {
      winner = player1;
      loser = player2;
    } else if (p2TotalScore > p1TotalScore) {
      winner = player2;
      loser = player1;
    }
    
    if (winner && loser) {
      previewMoney(winner.id, 10);
      previewMoney(loser.id, -10);
      const wScore = winner === player1 ? p1TotalScore : p2TotalScore;
      const lScore = loser === player1 ? p1TotalScore : p2TotalScore;
      io.emit('updateAreaE', { message: `${coloredName(winner.name, winner.color)}总分${wScore}获胜+10，${coloredName(loser.name, loser.color)}总分${lScore}败-10` });
    } else {
      io.emit('updateAreaE', { message: `${coloredName(player1.name, player1.color)}总分${p1TotalScore}，${coloredName(player2.name, player2.color)}总分${p2TotalScore}，平局` });
    }
    
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    
    texasHoldemState = null;
  }

  function caboBroadcastToSpectators(event, data) {
    caboSpectators.forEach(specId => {
      const specSocket = io.sockets.sockets.get(specId);
      if (specSocket) specSocket.emit(event, data);
    });
  }

  socket.on('caboPeek', ({ indices }) => {
    if (!caboState || socket.id !== caboState.callerId && socket.id !== caboState.opponentId) return;
    if (caboState.phase !== 'peek') return;
    if (!indices || indices.length !== 2) return;
    const isCaller = socket.id === caboState.callerId;
    if (isCaller) {
      if (caboState.playerPeeked >= 2) return;
      caboState.playerPeeked = 2;
      caboState.playerPeekIndices = indices;
    } else {
      if (caboState.opponentPeeked >= 2) return;
      caboState.opponentPeeked = 2;
      caboState.opponentPeekIndices = indices;
    }
    socket.emit('caboPeekResult', { indices, values: isCaller ? indices.map(i => caboState.playerCards[i]) : indices.map(i => caboState.opponentCards[i]) });
    const otherId = isCaller ? caboState.opponentId : caboState.callerId;
    const row = isCaller ? 'row3' : 'row4';
    io.to(otherId).emit('caboWhiteFrame', { row, indices });
    caboBroadcastToSpectators('caboWhiteFrame', { row, indices });
    if (caboState.playerPeeked >= 2 && caboState.opponentPeeked >= 2) {
      caboState.phase = 'play';
      caboState.currentTurnId = caboState.callerId;
      const turnName = caboState.callerName;
      const turnColor = caboState.callerColor;
      const discardTop = caboState.discardPile.length > 0 ? caboState.discardPile[caboState.discardPile.length - 1] : null;
      io.to(caboState.callerId).emit('caboTurnStart', { turnId: caboState.callerId, turnName, turnColor, discardTop });
      io.to(caboState.opponentId).emit('caboTurnStart', { turnId: caboState.callerId, turnName, turnColor, discardTop });
      caboBroadcastToSpectators('caboTurnStart', { turnId: caboState.callerId, turnName, turnColor, discardTop });
    }
  });

  socket.on('caboCallCabo', () => {
    if (!caboState || socket.id !== caboState.currentTurnId) return;
    if (caboState.phase !== 'play') return;
    caboState.caboCalled = true;
    caboState.caboCallerId = socket.id;
    const otherId = socket.id === caboState.callerId ? caboState.opponentId : caboState.callerId;
    caboState.lastTurnId = otherId;
    caboState.currentTurnId = otherId;
    const callerName = socket.id === caboState.callerId ? caboState.callerName : caboState.opponentName;
    const callerColor = socket.id === caboState.callerId ? caboState.callerColor : caboState.opponentColor;
    const otherName = socket.id === caboState.callerId ? caboState.opponentName : caboState.callerName;
    const otherColor = socket.id === caboState.callerId ? caboState.opponentColor : caboState.callerColor;
    io.to(caboState.callerId).emit('caboUpdate', { message: `${coloredName(callerName, callerColor)}呼叫了卡波，${coloredName(otherName, otherColor)}最后一个回合`, turnId: otherId, turnName: otherName, turnColor: otherColor, discardTop: caboState.discardPile.length > 0 ? caboState.discardPile[caboState.discardPile.length - 1] : null, caboCalled: true });
    io.to(caboState.opponentId).emit('caboUpdate', { message: `${coloredName(callerName, callerColor)}呼叫了卡波，${coloredName(otherName, otherColor)}最后一个回合`, turnId: otherId, turnName: otherName, turnColor: otherColor, discardTop: caboState.discardPile.length > 0 ? caboState.discardPile[caboState.discardPile.length - 1] : null, caboCalled: true });
    io.to(caboState.callerId).emit('caboClearShrink');
    io.to(caboState.opponentId).emit('caboClearShrink');
    caboBroadcastToSpectators('caboUpdate', { message: `${coloredName(callerName, callerColor)}呼叫了卡波，${coloredName(otherName, otherColor)}最后一个回合`, turnId: otherId, turnName: otherName, turnColor: otherColor, discardTop: caboState.discardPile.length > 0 ? caboState.discardPile[caboState.discardPile.length - 1] : null, caboCalled: true });
    caboBroadcastToSpectators('caboClearShrink');
  });

  socket.on('caboDrawDeck', () => {
    if (!caboState || socket.id !== caboState.currentTurnId) return;
    if (caboState.phase !== 'play') return;
    if (caboState.deck.length === 0) {
      caboSettle();
      return;
    }
    const card = caboState.deck.pop();
    caboState.drawnCard = card;
    caboState.actionPhase = 'drawn';
    const discardTop = caboState.discardPile.length > 0 ? caboState.discardPile[caboState.discardPile.length - 1] : null;
    const otherId = caboState.currentTurnId === caboState.callerId ? caboState.opponentId : caboState.callerId;
    socket.emit('caboDrawnCard', { card, discardTop });
    io.to(otherId).emit('caboDrawnCard', { card: null, discardTop });
    caboBroadcastToSpectators('caboDrawnCard', { card: null, discardTop });
    io.to(caboState.callerId).emit('caboClearShrink');
    io.to(caboState.opponentId).emit('caboClearShrink');
  });

  socket.on('caboDrawToDiscard', () => {
    if (!caboState || socket.id !== caboState.currentTurnId) return;
    if (caboState.actionPhase !== 'drawn') return;
    caboState.discardPile.push(caboState.drawnCard);
    const drawnValue = caboState.drawnCard;
    caboState.drawnCard = null;
    caboState.actionPhase = null;
    const isCaller = socket.id === caboState.callerId;
    const otherId = isCaller ? caboState.opponentId : caboState.callerId;
    const discardTop = drawnValue;
    io.to(caboState.callerId).emit('caboClearShrink');
    io.to(caboState.opponentId).emit('caboClearShrink');
    caboBroadcastToSpectators('caboClearShrink');
    if (drawnValue >= 7 && drawnValue <= 8) {
      caboState.actionPhase = 'peekOwn';
      socket.emit('caboAction', { action: 'peekOwn', discardTop });
      io.to(otherId).emit('caboAction', { action: 'peekOwn', discardTop });
      caboBroadcastToSpectators('caboAction', { action: 'peekOwn', discardTop });
      return;
    } else if (drawnValue >= 9 && drawnValue <= 10) {
      caboState.actionPhase = 'peekOther';
      socket.emit('caboAction', { action: 'peekOther', discardTop });
      io.to(otherId).emit('caboAction', { action: 'peekOther', discardTop });
      caboBroadcastToSpectators('caboAction', { action: 'peekOther', discardTop });
      return;
    } else if (drawnValue >= 11 && drawnValue <= 12) {
      caboState.actionPhase = 'swapMulti';
      socket.emit('caboAction', { action: 'swapMulti', discardTop });
      io.to(otherId).emit('caboAction', { action: 'swapMulti', discardTop });
      caboBroadcastToSpectators('caboAction', { action: 'swapMulti', discardTop });
      return;
    }
    caboEndTurn();
  });

  socket.on('caboSwapWithHand', ({ handIndex }) => {
    if (!caboState || socket.id !== caboState.currentTurnId) return;
    if (caboState.actionPhase !== 'drawn') return;
    const isCaller = socket.id === caboState.callerId;
    const myCards = isCaller ? caboState.playerCards : caboState.opponentCards;
    if (handIndex < 0 || handIndex >= myCards.length) return;
    const oldCard = myCards[handIndex];
    caboState.discardPile.push(oldCard);
    myCards[handIndex] = caboState.drawnCard;
    caboState.drawnCard = null;
    caboState.actionPhase = null;
    if (isCaller) {
      caboState.playerFaceUp = caboState.playerFaceUp.filter(i => i !== handIndex);
    } else {
      caboState.opponentFaceUp = caboState.opponentFaceUp.filter(i => i !== handIndex);
    }
    const otherId = isCaller ? caboState.opponentId : caboState.callerId;
    const myRow = isCaller ? 'row3' : 'row4';
    io.to(otherId).emit('caboWhiteFrame', { row: myRow, indices: [handIndex] });
    caboBroadcastToSpectators('caboWhiteFrame', { row: myRow, indices: [handIndex] });
    caboEndTurn();
  });

  socket.on('caboDrawExchange', ({ indices }) => {
    if (!caboState || socket.id !== caboState.currentTurnId) return;
    if (caboState.actionPhase !== 'drawn') return;
    const isCaller = socket.id === caboState.callerId;
    const myCards = isCaller ? caboState.playerCards : caboState.opponentCards;
    if (!Array.isArray(indices) || indices.length < 1) return;
    for (const idx of indices) {
      if (idx < 0 || idx >= myCards.length || myCards[idx] <= 0) return;
    }
    const drawnCard = caboState.drawnCard;
    caboState.drawnCard = null;
    caboState.actionPhase = null;
    const firstValue = myCards[indices[0]];
    const allEqual = indices.every(idx => myCards[idx] === firstValue);
    const myRow = isCaller ? 'row3' : 'row4';
    const maskCards = (cards, faceUp) => cards.map((c, i) => (faceUp.includes(i) || c === -1) ? c : 0);
    const currentFaceUpMap = () => ({ row3: [...caboState.playerFaceUp], row4: [...caboState.opponentFaceUp] });
    if (isCaller) {
      caboState.playerFaceUp = caboState.playerFaceUp.filter(i => !indices.includes(i));
    } else {
      caboState.opponentFaceUp = caboState.opponentFaceUp.filter(i => !indices.includes(i));
    }
    if (allEqual) {
      for (const idx of indices) {
        caboState.discardPile.push(myCards[idx]);
        myCards[idx] = -1;
      }
      let firstEmpty = -1;
      for (let i = 0; i < myCards.length; i++) {
        if (myCards[i] === -1) {
          firstEmpty = i;
          break;
        }
      }
      if (firstEmpty >= 0) {
        myCards[firstEmpty] = drawnCard;
      }
      const discardTop = caboState.discardPile[caboState.discardPile.length - 1];
      const otherId = isCaller ? caboState.opponentId : caboState.callerId;
      const shrinkIndices = { row3: [], row4: [] };
      if (firstEmpty >= 0) shrinkIndices[myRow] = [firstEmpty];
      const callerRow3 = [...caboState.playerCards];
      const callerRow4 = maskCards(caboState.opponentCards, caboState.opponentFaceUp);
      const oppRow3 = maskCards(caboState.playerCards, caboState.playerFaceUp);
      const oppRow4 = [...caboState.opponentCards];
      io.to(caboState.callerId).emit('caboDrawExchangeResult', {
        success: true,
        row3Cards: callerRow3,
        row4Cards: callerRow4,
        shrinkIndices,
        drawnCardValue: drawnCard,
        drawnCardPosition: firstEmpty,
        discardTop,
        faceUpMap: currentFaceUpMap()
      });
      io.to(caboState.opponentId).emit('caboDrawExchangeResult', {
        success: true,
        row3Cards: oppRow3,
        row4Cards: oppRow4,
        shrinkIndices,
        drawnCardValue: null,
        drawnCardPosition: firstEmpty,
        discardTop,
        faceUpMap: currentFaceUpMap()
      });
      caboBroadcastToSpectators('caboDrawExchangeResult', {
        success: true,
        row3Cards: callerRow3,
        row4Cards: callerRow4,
        shrinkIndices,
        drawnCardValue: null,
        drawnCardPosition: firstEmpty,
        discardTop,
        faceUpMap: currentFaceUpMap()
      });
    } else {
      myCards.push(drawnCard);
      const discardTop = caboState.discardPile.length > 0 ? caboState.discardPile[caboState.discardPile.length - 1] : null;
      const shrinkIndices = { row3: [], row4: [] };
      shrinkIndices[myRow] = [...indices];
      const callerRow3 = [...caboState.playerCards];
      const callerRow4 = maskCards(caboState.opponentCards, caboState.opponentFaceUp);
      const oppRow3 = maskCards(caboState.playerCards, caboState.playerFaceUp);
      const oppRow4 = [...caboState.opponentCards];
      io.to(caboState.callerId).emit('caboDrawExchangeResult', {
        success: false,
        row3Cards: callerRow3,
        row4Cards: callerRow4,
        shrinkIndices,
        drawnCardValue: null,
        drawnCardPosition: -1,
        discardTop,
        faceUpMap: currentFaceUpMap()
      });
      io.to(caboState.opponentId).emit('caboDrawExchangeResult', {
        success: false,
        row3Cards: oppRow3,
        row4Cards: oppRow4,
        shrinkIndices,
        drawnCardValue: null,
        drawnCardPosition: -1,
        discardTop,
        faceUpMap: currentFaceUpMap()
      });
      caboBroadcastToSpectators('caboDrawExchangeResult', {
        success: false,
        row3Cards: callerRow3,
        row4Cards: callerRow4,
        shrinkIndices,
        drawnCardValue: null,
        drawnCardPosition: -1,
        discardTop,
        faceUpMap: currentFaceUpMap()
      });
    }
    caboEndTurn();
  });

  socket.on('caboTakeDiscard', () => {
    if (!caboState || socket.id !== caboState.currentTurnId) return;
    if (caboState.phase !== 'play') return;
    if (caboState.discardPile.length === 0) return;
    caboState.actionPhase = 'takeDiscard';
    const card = caboState.discardPile[caboState.discardPile.length - 1];
    const isCaller = socket.id === caboState.callerId;
    const otherId = isCaller ? caboState.opponentId : caboState.callerId;
    socket.emit('caboTookDiscard', { card });
    io.to(otherId).emit('caboTookDiscard', { card });
    caboBroadcastToSpectators('caboTookDiscard', { card });
    io.to(caboState.callerId).emit('caboClearShrink');
    io.to(caboState.opponentId).emit('caboClearShrink');
    caboBroadcastToSpectators('caboClearShrink');
  });

  socket.on('caboDiscardExchange', ({ indices }) => {
    if (!caboState || socket.id !== caboState.currentTurnId) return;
    if (caboState.actionPhase !== 'takeDiscard') return;
    const isCaller = socket.id === caboState.callerId;
    const myCards = isCaller ? caboState.playerCards : caboState.opponentCards;
    if (!Array.isArray(indices) || indices.length < 1) return;
    for (const idx of indices) {
      if (idx < 0 || idx >= myCards.length || myCards[idx] <= 0) return;
    }
    const discardCard = caboState.discardPile.pop();
    caboState.actionPhase = null;
    const firstValue = myCards[indices[0]];
    const allEqual = indices.every(idx => myCards[idx] === firstValue);
    const myRow = isCaller ? 'row3' : 'row4';
    const maskCards = (cards, faceUp) => cards.map((c, i) => (faceUp.includes(i) || c === -1) ? c : 0);
    const currentFaceUpMap = () => ({ row3: [...caboState.playerFaceUp], row4: [...caboState.opponentFaceUp] });
    if (isCaller) {
      caboState.playerFaceUp = caboState.playerFaceUp.filter(i => !indices.includes(i));
    } else {
      caboState.opponentFaceUp = caboState.opponentFaceUp.filter(i => !indices.includes(i));
    }
    if (allEqual) {
      for (const idx of indices) {
        caboState.discardPile.push(myCards[idx]);
        myCards[idx] = -1;
      }
      let firstEmpty = -1;
      for (let i = 0; i < myCards.length; i++) {
        if (myCards[i] === -1) {
          firstEmpty = i;
          break;
        }
      }
      if (firstEmpty >= 0) {
        myCards[firstEmpty] = discardCard;
        if (isCaller) {
          caboState.playerFaceUp.push(firstEmpty);
        } else {
          caboState.opponentFaceUp.push(firstEmpty);
        }
      }
      const discardTop = caboState.discardPile.length > 0 ? caboState.discardPile[caboState.discardPile.length - 1] : null;
      const shrinkIndices = { row3: [], row4: [] };
      if (firstEmpty >= 0) shrinkIndices[myRow] = [firstEmpty];
      const callerRow3 = [...caboState.playerCards];
      const callerRow4 = maskCards(caboState.opponentCards, caboState.opponentFaceUp);
      const oppRow3 = maskCards(caboState.playerCards, caboState.playerFaceUp);
      const oppRow4 = [...caboState.opponentCards];
      io.to(caboState.callerId).emit('caboDrawExchangeResult', {
        success: true,
        row3Cards: callerRow3,
        row4Cards: callerRow4,
        shrinkIndices,
        drawnCardValue: discardCard,
        drawnCardPosition: firstEmpty,
        discardTop,
        faceUpMap: currentFaceUpMap()
      });
      io.to(caboState.opponentId).emit('caboDrawExchangeResult', {
        success: true,
        row3Cards: oppRow3,
        row4Cards: oppRow4,
        shrinkIndices,
        drawnCardValue: null,
        drawnCardPosition: firstEmpty,
        discardTop,
        faceUpMap: currentFaceUpMap()
      });
      caboBroadcastToSpectators('caboDrawExchangeResult', {
        success: true,
        row3Cards: callerRow3,
        row4Cards: callerRow4,
        shrinkIndices,
        drawnCardValue: null,
        drawnCardPosition: firstEmpty,
        discardTop,
        faceUpMap: currentFaceUpMap()
      });
      caboEndTurn();
    } else {
      for (const idx of indices) {
        caboState.discardPile.push(myCards[idx]);
      }
      myCards.push(discardCard);
      const newIdx = myCards.length - 1;
      if (isCaller) {
        caboState.playerFaceUp.push(newIdx);
      } else {
        caboState.opponentFaceUp.push(newIdx);
      }
      if (myCards.length >= 6) {
        const loserId = socket.id;
        const winnerId = isCaller ? caboState.opponentId : caboState.callerId;
        const loserName = isCaller ? caboState.callerName : caboState.opponentName;
        const winnerName = isCaller ? caboState.opponentName : caboState.callerName;
        const loserColor = isCaller ? caboState.callerColor : caboState.opponentColor;
        const winnerColor = isCaller ? caboState.opponentColor : caboState.callerColor;
        const callerRow3 = [...caboState.playerCards];
        const callerRow4 = maskCards(caboState.opponentCards, caboState.opponentFaceUp);
        const oppRow3 = maskCards(caboState.playerCards, caboState.playerFaceUp);
        const oppRow4 = [...caboState.opponentCards];
        io.to(caboState.callerId).emit('caboDrawExchangeResult', {
          success: false,
          row3Cards: callerRow3,
          row4Cards: callerRow4,
          shrinkIndices: isCaller ? { row3: [newIdx], row4: [] } : { row3: [], row4: [newIdx] },
          drawnCardValue: null,
          drawnCardPosition: -1,
          discardTop: caboState.discardPile.length > 0 ? caboState.discardPile[caboState.discardPile.length - 1] : null,
          faceUpMap: currentFaceUpMap()
        });
        io.to(caboState.opponentId).emit('caboDrawExchangeResult', {
          success: false,
          row3Cards: oppRow3,
          row4Cards: oppRow4,
          shrinkIndices: isCaller ? { row3: [newIdx], row4: [] } : { row3: [], row4: [newIdx] },
          drawnCardValue: null,
          drawnCardPosition: -1,
          discardTop: caboState.discardPile.length > 0 ? caboState.discardPile[caboState.discardPile.length - 1] : null,
          faceUpMap: currentFaceUpMap()
        });
        caboBroadcastToSpectators('caboDrawExchangeResult', {
          success: false,
          row3Cards: callerRow3,
          row4Cards: callerRow4,
          shrinkIndices: isCaller ? { row3: [newIdx], row4: [] } : { row3: [], row4: [newIdx] },
          drawnCardValue: null,
          drawnCardPosition: -1,
          discardTop: caboState.discardPile.length > 0 ? caboState.discardPile[caboState.discardPile.length - 1] : null,
          faceUpMap: currentFaceUpMap()
        });
        caboSettle();
        return;
      }
      const discardTop = caboState.discardPile.length > 0 ? caboState.discardPile[caboState.discardPile.length - 1] : null;
      const shrinkIndices = { row3: [], row4: [] };
      shrinkIndices[myRow] = [newIdx];
      const callerRow3 = [...caboState.playerCards];
      const callerRow4 = maskCards(caboState.opponentCards, caboState.opponentFaceUp);
      const oppRow3 = maskCards(caboState.playerCards, caboState.playerFaceUp);
      const oppRow4 = [...caboState.opponentCards];
      io.to(caboState.callerId).emit('caboDrawExchangeResult', {
        success: false,
        row3Cards: callerRow3,
        row4Cards: callerRow4,
        shrinkIndices,
        drawnCardValue: null,
        drawnCardPosition: -1,
        discardTop,
        faceUpMap: currentFaceUpMap()
      });
      io.to(caboState.opponentId).emit('caboDrawExchangeResult', {
        success: false,
        row3Cards: oppRow3,
        row4Cards: oppRow4,
        shrinkIndices,
        drawnCardValue: null,
        drawnCardPosition: -1,
        discardTop,
        faceUpMap: currentFaceUpMap()
      });
      caboBroadcastToSpectators('caboDrawExchangeResult', {
        success: false,
        row3Cards: callerRow3,
        row4Cards: callerRow4,
        shrinkIndices,
        drawnCardValue: null,
        drawnCardPosition: -1,
        discardTop,
        faceUpMap: currentFaceUpMap()
      });
      caboEndTurn();
    }
  });

  socket.on('caboPeekOwnCard', ({ handIndex }) => {
    if (!caboState || socket.id !== caboState.currentTurnId) return;
    if (caboState.actionPhase !== 'peekOwn') return;
    const isCaller = socket.id === caboState.callerId;
    const myCards = isCaller ? caboState.playerCards : caboState.opponentCards;
    if (handIndex < 0 || handIndex >= myCards.length) return;
    socket.emit('caboPeekResult', { indices: [handIndex], values: [myCards[handIndex]] });
    const otherId = isCaller ? caboState.opponentId : caboState.callerId;
    const row = isCaller ? 'row3' : 'row4';
    io.to(otherId).emit('caboWhiteFrame', { row, indices: [handIndex] });
    caboBroadcastToSpectators('caboWhiteFrame', { row, indices: [handIndex] });
    caboState.actionPhase = null;
    caboEndTurn();
  });

  socket.on('caboPeekOtherCard', ({ handIndex }) => {
    if (!caboState || socket.id !== caboState.currentTurnId) return;
    if (caboState.actionPhase !== 'peekOther') return;
    const isCaller = socket.id === caboState.callerId;
    const otherCards = isCaller ? caboState.opponentCards : caboState.playerCards;
    if (handIndex < 0 || handIndex >= otherCards.length) return;
    socket.emit('caboPeekOtherResult', { index: handIndex, value: otherCards[handIndex] });
    const otherId = isCaller ? caboState.opponentId : caboState.callerId;
    const row = isCaller ? 'row4' : 'row3';
    io.to(otherId).emit('caboWhiteFrame', { row, indices: [handIndex] });
    caboBroadcastToSpectators('caboWhiteFrame', { row: isCaller ? 'row4' : 'row3', indices: [handIndex] });
    caboState.actionPhase = null;
    caboEndTurn();
  });

  socket.on('caboSwapMulti', ({ myIndices, otherIndex }) => {
    if (!caboState || socket.id !== caboState.currentTurnId) return;
    if (caboState.actionPhase !== 'swapMulti') return;
    const isCaller = socket.id === caboState.callerId;
    const myCards = isCaller ? caboState.playerCards : caboState.opponentCards;
    const otherCards = isCaller ? caboState.opponentCards : caboState.playerCards;
    if (!Array.isArray(myIndices) || myIndices.length !== 1) return;
    for (const idx of myIndices) {
      if (idx < 0 || idx >= myCards.length) return;
    }
    if (otherIndex < 0 || otherIndex >= otherCards.length) return;
    const otherCard = otherCards[otherIndex];
    const myIdx = myIndices[0];
    const myCard = myCards[myIdx];
    otherCards[otherIndex] = myCard;
    myCards[myIdx] = otherCard;
    caboState.actionPhase = null;
    const myWasFaceUp = isCaller ? caboState.playerFaceUp.includes(myIdx) : caboState.opponentFaceUp.includes(myIdx);
    const otherWasFaceUp = isCaller ? caboState.opponentFaceUp.includes(otherIndex) : caboState.playerFaceUp.includes(otherIndex);
    if (isCaller) {
      caboState.playerFaceUp = caboState.playerFaceUp.filter(i => i !== myIdx);
      caboState.opponentFaceUp = caboState.opponentFaceUp.filter(i => i !== otherIndex);
      if (otherWasFaceUp) caboState.playerFaceUp.push(myIdx);
      if (myWasFaceUp) caboState.opponentFaceUp.push(otherIndex);
    } else {
      caboState.opponentFaceUp = caboState.opponentFaceUp.filter(i => i !== myIdx);
      caboState.playerFaceUp = caboState.playerFaceUp.filter(i => i !== otherIndex);
      if (otherWasFaceUp) caboState.opponentFaceUp.push(myIdx);
      if (myWasFaceUp) caboState.playerFaceUp.push(otherIndex);
    }
    const maskCards = (cards, faceUp) => cards.map((c, i) => (faceUp.includes(i) || c === -1) ? c : 0);
    const callerRow3 = [...caboState.playerCards];
    const callerRow4 = maskCards(caboState.opponentCards, caboState.opponentFaceUp);
    const oppRow3 = maskCards(caboState.playerCards, caboState.playerFaceUp);
    const oppRow4 = [...caboState.opponentCards];
    io.to(caboState.callerId).emit('caboMultiSwapped', {
      row3Cards: callerRow3,
      row4Cards: callerRow4,
      shrinkIndices: isCaller ? { row3: [myIdx], row4: [otherIndex] } : { row3: [otherIndex], row4: [myIdx] },
      faceUpMap: { row3: [...caboState.playerFaceUp], row4: [...caboState.opponentFaceUp] }
    });
    io.to(caboState.opponentId).emit('caboMultiSwapped', {
      row3Cards: oppRow3,
      row4Cards: oppRow4,
      shrinkIndices: isCaller ? { row3: [myIdx], row4: [otherIndex] } : { row3: [otherIndex], row4: [myIdx] },
      faceUpMap: { row3: [...caboState.playerFaceUp], row4: [...caboState.opponentFaceUp] }
    });
    caboBroadcastToSpectators('caboMultiSwapped', {
      row3Cards: callerRow3,
      row4Cards: callerRow4,
      shrinkIndices: isCaller ? { row3: [myIdx], row4: [otherIndex] } : { row3: [otherIndex], row4: [myIdx] },
      faceUpMap: { row3: [...caboState.playerFaceUp], row4: [...caboState.opponentFaceUp] }
    });
    caboEndTurn();
  });

  socket.on('caboSkipSwap', () => {
    if (!caboState || socket.id !== caboState.currentTurnId) return;
    if (caboState.actionPhase !== 'swapMulti') return;
    caboState.actionPhase = null;
    caboEndTurn();
  });

  function caboEndTurn() {
    if (!caboState) return;
    if (caboState.caboCalled && caboState.lastTurnId === caboState.currentTurnId) {
      const discardTop = caboState.discardPile.length > 0 ? caboState.discardPile[caboState.discardPile.length - 1] : null;
      io.to(caboState.callerId).emit('caboUpdateDiscardTop', { discardTop });
      io.to(caboState.opponentId).emit('caboUpdateDiscardTop', { discardTop });
      caboBroadcastToSpectators('caboUpdateDiscardTop', { discardTop });
      caboSettle();
      return;
    }
    const nextId = caboState.currentTurnId === caboState.callerId ? caboState.opponentId : caboState.callerId;
    caboState.currentTurnId = nextId;
    const nextName = nextId === caboState.callerId ? caboState.callerName : caboState.opponentName;
    const nextColor = nextId === caboState.callerId ? caboState.callerColor : caboState.opponentColor;
    const discardTop = caboState.discardPile.length > 0 ? caboState.discardPile[caboState.discardPile.length - 1] : null;
    io.to(caboState.callerId).emit('caboTurnStart', { turnId: nextId, turnName: nextName, turnColor: nextColor, discardTop });
    io.to(caboState.opponentId).emit('caboTurnStart', { turnId: nextId, turnName: nextName, turnColor: nextColor, discardTop });
    caboBroadcastToSpectators('caboTurnStart', { turnId: nextId, turnName: nextName, turnColor: nextColor, discardTop });
  }

  function caboSettle() {
    if (!caboState) return;
    const p1Sum = caboState.playerCards.filter(c => c > 0).reduce((a, b) => a + b, 0);
    const p2Sum = caboState.opponentCards.filter(c => c > 0).reduce((a, b) => a + b, 0);
    let winner, loser;
    if (p1Sum < p2Sum) {
      winner = { id: caboState.callerId, name: caboState.callerName, color: caboState.callerColor, sum: p1Sum };
      loser = { id: caboState.opponentId, name: caboState.opponentName, color: caboState.opponentColor, sum: p2Sum };
    } else if (p2Sum < p1Sum) {
      winner = { id: caboState.opponentId, name: caboState.opponentName, color: caboState.opponentColor, sum: p2Sum };
      loser = { id: caboState.callerId, name: caboState.callerName, color: caboState.callerColor, sum: p1Sum };
    } else {
      if (caboState.caboCallerId === caboState.callerId) {
        winner = { id: caboState.callerId, name: caboState.callerName, color: caboState.callerColor, sum: p1Sum };
        loser = { id: caboState.opponentId, name: caboState.opponentName, color: caboState.opponentColor, sum: p2Sum };
      } else {
        winner = { id: caboState.opponentId, name: caboState.opponentName, color: caboState.opponentColor, sum: p2Sum };
        loser = { id: caboState.callerId, name: caboState.callerName, color: caboState.callerColor, sum: p1Sum };
      }
    }
    const equalScore = p1Sum === p2Sum;
    const loserPlayer = players.find(p => p.id === loser.id);
    if (loserPlayer) {
      previewMoney(loser.id, -12);
    }
    const winnerPlayer = players.find(p => p.id === winner.id);
    if (winnerPlayer) {
      previewMoney(winner.id, 12);
    }
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
    io.emit('updateAreaE', { message: `${coloredName(winner.name, winner.color)}胜利，赢得${coloredName(loser.name, loser.color)}12` });
    io.to(caboState.callerId).emit('caboSettle', {
      playerCards: caboState.playerCards,
      opponentCards: caboState.opponentCards,
      playerSum: p1Sum,
      opponentSum: p2Sum,
      winnerId: winner.id,
      winnerName: winner.name,
      winnerColor: winner.color,
      loserName: loser.name,
      loserColor: loser.color,
      isCaller: true,
      equalScore
    });
    io.to(caboState.opponentId).emit('caboSettle', {
      playerCards: caboState.opponentCards,
      opponentCards: caboState.playerCards,
      playerSum: p2Sum,
      opponentSum: p1Sum,
      winnerId: winner.id,
      winnerName: winner.name,
      winnerColor: winner.color,
      loserName: loser.name,
      loserColor: loser.color,
      isCaller: false,
      equalScore
    });
    caboBroadcastToSpectators('caboSettle', {
      playerCards: caboState.playerCards,
      opponentCards: caboState.opponentCards,
      playerSum: p1Sum,
      opponentSum: p2Sum,
      winnerId: winner.id,
      winnerName: winner.name,
      winnerColor: winner.color,
      loserName: loser.name,
      loserColor: loser.color,
      isCaller: true,
      equalScore
    });
    caboState = null;
  }

  socket.on('caboClose', () => {
    const otherId = caboOpponentMap[socket.id];
    if (otherId) {
      io.to(otherId).emit('caboForceClose');
      caboBroadcastToSpectators('caboForceClose');
      caboSpectators.clear();
      delete caboOpponentMap[socket.id];
      delete caboOpponentMap[otherId];
    }
    if (caboState) {
      caboState = null;
    }
    const cur = players[currentPlayerIndex];
    if (cur && cur.id === socket.id) {
      socket.emit('showEndTurn');
    }
  });

  // ===== 金花事件 =====
  function jinhuaCardRank(imageIndex) {
    return Math.floor(imageIndex / 4) + 1;
  }

  function jinhuaCardPoints(imageIndex) {
    const rank = jinhuaCardRank(imageIndex);
    return rank;
  }

  function jinhuaBroadcast(event, data) {
    if (!jinhuaState) return;
    jinhuaState.players.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) s.emit(event, data);
    });
  }

  socket.on('jinhuaOpenPanel', () => {
    if (!jinhuaState) return;
    // Auto-draw cards for all players
    jinhuaState.players.forEach(p => {
      if (p.cards.length === 0) {
        const cards = drawPukepaiCards(2);
        p.cards = cards.map(c => c.imageIndex);
        p.cardSum = p.cards.reduce((s, c) => s + jinhuaCardPoints(c), 0);
      }
    });
    // Send each player their own cards
    jinhuaState.players.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) {
        s.emit('jinhuaCardsDrawn', { cards: p.cards, cardSum: p.cardSum });
      }
    });
    // Broadcast that all players have drawn
    jinhuaState.phase = 'swap';
    jinhuaBroadcast('jinhuaAllDrawn', { firstBetPlayerId: jinhuaState.players[0].id });
    jinhuaBroadcast('jinhuaShowPanel');
  });

  socket.on('jinhuaDrawCard', () => {
    if (!jinhuaState) return;
    const pData = jinhuaState.players.find(p => p.id === socket.id);
    if (!pData || pData.cards.length > 0) return;
    const cards = drawPukepaiCards(2);
    pData.cards = cards.map(c => c.imageIndex);
    pData.cardSum = pData.cards.reduce((s, c) => s + jinhuaCardPoints(c), 0);
    socket.emit('jinhuaCardsDrawn', { cards: pData.cards, cardSum: pData.cardSum });
    jinhuaBroadcast('jinhuaPlayerDrawn', { playerId: socket.id });
    const allDrawn = jinhuaState.players.every(p => p.cards.length > 0);
    if (allDrawn) {
      jinhuaState.phase = 'swap';
      jinhuaBroadcast('jinhuaAllDrawn', { firstBetPlayerId: jinhuaState.players[0].id });
    }
  });

  socket.on('jinhuaSwapCards', () => {
    if (!jinhuaState) return;
    if (jinhuaState.phase !== 'swap' && jinhuaState.phase !== 'bet') return;
    const pData = jinhuaState.players.find(p => p.id === socket.id);
    if (!pData || pData.swapped || pData.gaveUp) return;
    // Only allow swap on own turn
    const betPlayerIdx = jinhuaState.currentBetPlayerIndex;
    if (jinhuaState.players[betPlayerIdx].id !== socket.id) return;
    pData.swapped = true;
    const newCards = drawPukepaiCards(2);
    pData.cards = newCards.map(c => c.imageIndex);
    pData.cardSum = pData.cards.reduce((s, c) => s + jinhuaCardPoints(c), 0);
    socket.emit('jinhuaCardsSwapped', { cards: pData.cards, cardSum: pData.cardSum });
    jinhuaBroadcast('jinhuaPlayerSwapped', { playerId: socket.id });
  });

  socket.on('jinhuaBet', ({ amount }) => {
    if (!jinhuaState) return;
    const betAmount = amount || 1;
    if (betAmount !== 1 && betAmount !== 2) return;
    const pData = jinhuaState.players.find(p => p.id === socket.id);
    if (!pData || pData.gaveUp) return;
    const betPlayerIdx = jinhuaState.currentBetPlayerIndex;
    if (jinhuaState.players[betPlayerIdx].id !== socket.id) return;
    // Transition from swap to bet phase if needed
    if (jinhuaState.phase === 'swap') {
      jinhuaState.phase = 'bet';
    }
    if (jinhuaState.phase !== 'bet') return;
    const maxBet = Math.max(...jinhuaState.players.filter(p => !p.gaveUp).map(p => p.betCount));
    const newBetCount = maxBet + betAmount;
    if (pData.cardSum - newBetCount <= 0) return;
    pData.betCount = newBetCount;
    const newMaxBet = Math.max(...jinhuaState.players.filter(p => !p.gaveUp).map(p => p.betCount));
    jinhuaBroadcast('jinhuaPlayerBet', { playerId: socket.id, betCount: pData.betCount, newSum: pData.cardSum - pData.betCount, maxBet: newMaxBet });
    // Move to next non-gaveUp player
    let nextIdx = (betPlayerIdx + 1) % jinhuaState.players.length;
    while (jinhuaState.players[nextIdx].gaveUp) {
      nextIdx = (nextIdx + 1) % jinhuaState.players.length;
    }
    // Check if only 1 player left
    const activePlayers = jinhuaState.players.filter(p => !p.gaveUp);
    if (activePlayers.length <= 1) {
      jinhuaSettle(activePlayers[0]);
      return;
    }
    jinhuaState.currentBetPlayerIndex = nextIdx;
    const nextP = jinhuaState.players[nextIdx];
    jinhuaBroadcast('jinhuaNextTurn', { currentPlayerId: nextP.id, maxBet: newMaxBet });
  });

  socket.on('jinhuaGiveUp', () => {
    if (!jinhuaState) return;
    const pData = jinhuaState.players.find(p => p.id === socket.id);
    if (!pData || pData.gaveUp) return;
    const betPlayerIdx = jinhuaState.currentBetPlayerIndex;
    if (jinhuaState.players[betPlayerIdx].id !== socket.id) return;
    // Transition from swap to bet phase if needed
    if (jinhuaState.phase === 'swap') {
      jinhuaState.phase = 'bet';
    }
    if (jinhuaState.phase !== 'bet') return;
    pData.gaveUp = true;
    jinhuaBroadcast('jinhuaPlayerGaveUp', { playerId: socket.id });
    const activePlayers = jinhuaState.players.filter(p => !p.gaveUp);
    if (activePlayers.length <= 1) {
      jinhuaSettle(activePlayers[0]);
      return;
    }
    let nextIdx = (betPlayerIdx + 1) % jinhuaState.players.length;
    while (jinhuaState.players[nextIdx].gaveUp) {
      nextIdx = (nextIdx + 1) % jinhuaState.players.length;
    }
    jinhuaState.currentBetPlayerIndex = nextIdx;
    jinhuaBroadcast('jinhuaNextTurn', { currentPlayerId: jinhuaState.players[nextIdx].id });
  });

  function jinhuaSettle(winner) {
    if (!jinhuaState || !winner) return;
    jinhuaState.phase = 'settle';
    // Draw bank cards
    const bankCards = drawPukepaiCards(2);
    jinhuaState.bankCards = bankCards.map(c => c.imageIndex);
    jinhuaState.bankSum = jinhuaState.bankCards.reduce((s, c) => s + jinhuaCardPoints(c), 0);
    const H = winner.cardSum - winner.betCount;
    const S = jinhuaState.bankSum;
    const winnerPlayer = players.find(p => p.id === winner.id);
    let eMsg = '';
    if (H >= S) {
      // Winner wins
      const betDetails = [];
      const noBetNames = [];
      jinhuaState.players.forEach(p => {
        if (p.id === winner.id) return;
        const targetPlayer = players.find(tp => tp.id === p.id);
        if (targetPlayer) {
          const betExtra = p.betCount;
          const giveAmount = 5 + betExtra;
          previewMoney(winner.id, giveAmount);
          previewMoney(p.id, -giveAmount);
          if (betExtra > 0) {
            betDetails.push(`${coloredName(p.name, p.color)}${giveAmount}`);
          } else {
            noBetNames.push(coloredName(p.name, p.color));
          }
        }
      });
      let winStr = '';
      if (betDetails.length > 0) {
        winStr += `赢得${betDetails.join('，')}`;
        if (noBetNames.length > 0) winStr += `，${noBetNames.join(',')}5`;
      } else {
        winStr += `赢得${noBetNames.join(',')}5`;
      }
      eMsg = `银行点数和为${S}，${coloredName(winner.name, winner.color)}最终点数${H}获胜，${winStr}`;
    } else {
      // Winner loses
      const loseAmount = 5 + winner.betCount;
      previewMoney(winner.id, -loseAmount);
      const noBetNames = [];
      const betDetails = [];
      jinhuaState.players.forEach(p => {
        if (p.id === winner.id) return;
        const targetPlayer = players.find(tp => tp.id === p.id);
        if (targetPlayer) {
          if (p.betCount > 0) {
            const total = 5 + p.betCount;
            previewMoney(p.id, total);
            betDetails.push(`${coloredName(p.name, p.color)}+${total}`);
          } else {
            previewMoney(p.id, 5);
            noBetNames.push(coloredName(p.name, p.color));
          }
        }
      });
      const noBetStr = noBetNames.length > 0 ? `${noBetNames.join(',')}+5` : '';
      const betStr = betDetails.join('，');
      const detailStr = [noBetStr, betStr].filter(s => s).join('，');
      eMsg = `银行点数和为${S}，${coloredName(winner.name, winner.color)}最终点数${H}失败-${loseAmount}，${detailStr}`;
    }
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, kunlunState });
    jinhuaBroadcast('jinhuaSettle', {
      bankCards: jinhuaState.bankCards,
      bankSum: S,
      winnerId: winner.id,
      winnerSum: H,
      won: H >= S,
      eMsg: eMsg,
      allPlayerCards: jinhuaState.players.map(p => ({ playerId: p.id, cards: p.cards, gaveUp: p.gaveUp, betCount: p.betCount }))
    });
  }

  socket.on('jinhuaClose', () => {
    if (!jinhuaState) return;
    const isInitiator = socket.id === jinhuaState.currentPlayerId;
    jinhuaBroadcast('jinhuaForceClose');
    jinhuaState = null;
    initPukepaiDeck();
    shufflePukepaiDeck();
    if (isInitiator) {
      socket.emit('showEndTurn');
    }
  });

  socket.on('disconnect', () => {
    activeInLobby.delete(socket.id);
    delete texasWatchers[socket.id];
    // 断开连接时清除temporaryPlayerDataStore，只有离线时才使用
    delete temporaryPlayerDataStore[socket.id];
  });

  socket.on('restart', () => {
    restartVotes.add(socket.id);
    const activePlayers = players.filter(p => !p.bankrupt);
    io.emit('voteUpdate', { type: 'restart', voted: restartVotes.size, total: activePlayers.length });
    
    if (restartVotes.size >= activePlayers.length) {
      players = [];
      activeInLobby.clear();
      selectedCharacters = {};
      gameState = 'waiting';
      currentPlayerIndex = 0;
      currentDiceValue = 0;
      roundCounter = 0;
      diamondHolder = true;
      diamondProgress = 0;
      diamondProgressPlayerId = null;
      diamondProgressPlayerColor = null;
      rouletteRemaining = 0;
      rouletteTargets = [];
      kunlunState = null;
      dayunState = null;
      fanzhuanState = null;
      xinlixueState = null;
      lianhuanjiState = null;
      sansiState = null;
      qiyuState = null;
      jiyuQueue = [];
      xianzhiState = null;
      tuisuanState = null;
      jiandieState = null;
      tudijianbingState = null;
      chuanxiaoState = null;
      meirenjiState = null;
      jidiState = null;
      xiaolicangdaoState = null;
      board.forEach(s => { s.owner = null; s.houseLevel = 0; s.closed = false; });
      restartVotes.clear();
      startGameVotes.clear();
      deleteTempSave();
      io.emit('restart');
    }
  });

  socket.on('restartServer', () => {
    // 发送serverRestarting事件，通知客户端清除localStorage（除了保存的游戏数据）
    io.emit('serverRestarting', { clearLocalStorage: true });
    
    // 注意：不删除保存的游戏文件（saved_game.json），保存的游戏数据只能手动删除
    // 清理所有临时保存数据
    clearTemporaryPlayerData();
    players = [];
    activeInLobby.clear();
    selectedCharacters = {};
    gameState = 'waiting';
    currentPlayerIndex = 0;
    currentDiceValue = 0;
    roundCounter = 0;
    sansiState = null;
    qiyuState = null;
    jiyuQueue = [];
    baohuQueryState = null;
    board.forEach(s => { s.owner = null; s.houseLevel = 0; s.closed = false; });
    restartVotes.clear();
    startGameVotes.clear();
    deleteTempSave();
    io.emit('restart');
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });

  socket.on('checkSaveGame', () => {
    const savePath = path.join(__dirname, 'saved_game.json');
    const exists = fs.existsSync(savePath);
    socket.emit('checkSaveGameResult', { exists });
  });

  socket.on('saveGame', (data = {}) => {
    const saveData = {
      players: players.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        character: p.character,
        variant: p.variant,
        money: p.money,
        position: p.position,
        bankrupt: p.bankrupt,
        cards: p.cards,
        extraPets: p.extraPets,
        petImage: p.petImage,
        petInfo: p.petImage ? getPetInfo(p.petImage) : null,
        petFlipped: p.petFlipped,
        salary: p.salary,
        inJail: p.inJail,
        jailTurns: p.jailTurns,
        jailDice: p.jailDice,
        restTurns: p.restTurns,
        sheltered: p.sheltered,
        shelteredTurns: p.shelteredTurns,
        frozen: p.frozen,
        fengdiTurns: p.fengdiTurns || 0,
        shihua: p.shihua,
        extraTurns: p.extraTurns,
        fuwufeiExtraMove: p.fuwufeiExtraMove,
        guhuoDice: p.guhuoDice,
        guhuoBy: p.guhuoBy,
        shoumaiDice: p.shoumaiDice,
        yinyueDice: p.yinyueDice,
        yinyueBy: p.yinyueBy,
        shijieWar: p.shijieWar,
        diceEffects: p.diceEffects,
        daotui: p.daotui,
        bingdongTurns: p.bingdongTurns,
        bomingFrozen: p.bomingFrozen,
        jinzu: p.jinzu,
        tuolei: p.tuolei,
        wenji: p.wenji,
        dizhu: p.dizhu,
        fengkongDice: p.fengkongDice,
        syncedDice: p.syncedDice,
        syncedByName: p.syncedByName,
        cunqianRounds: p.cunqianRounds,
        statusIcons: p.statusIcons,
        hezongState: p.hezongState,
        hezongTurns: p.hezongTurns,
        hezongTarget: p.hezongTarget,
        petPlaceholder: p.petPlaceholder,
        zaie: p.zaie,
        hasDiamond: p.hasDiamond,
        loans: p.loans || []
      })),
      board: board.map(s => ({
        id: s.id,
        name: s.name,
        type: s.type,
        isProperty: s.isProperty,
        price: s.price,
        rent: s.rent,
        owner: s.owner,
        houseLevel: s.houseLevel,
        closed: s.closed,
        displayName: s.displayName,
        rentBonus: s.rentBonus,
        airportType: s.airportType || null
      })),
      gameState: gameState,
      currentPlayerIndex: currentPlayerIndex,
      selectedCharacters: selectedCharacters,
      currentDiceValue: currentDiceValue,
      roundCounter: roundCounter,
      diamondHolder: diamondHolder,
      diamondProgress: diamondProgress,
      diamondProgressPlayerId: diamondProgressPlayerId,
      diamondProgressPlayerColor: diamondProgressPlayerColor,
      rouletteRemaining: rouletteRemaining,
      kunlunState: kunlunState,
      dayunState: dayunState,
      zhadanState: zhadanState,
      fanzhuanState: fanzhuanState,
      xinlixueState: xinlixueState,
      lianhuanjiState: lianhuanjiState,
      sansiState: sansiState,
      qiyuState: qiyuState,
      jiyuQueue: jiyuQueue,
      xianzhiState: xianzhiState,
      tuisuanState: tuisuanState,
      jiandieState: jiandieState,
      tudijianbingState: tudijianbingState,
      chuanxiaoState: chuanxiaoState,
      meirenjiState: meirenjiState,
      jidiState: jidiState,
      xiaolicangdaoState: xiaolicangdaoState,
      hezongFirstPlayerId: hezongFirstPlayerId,
      lastAreaEMessage: lastAreaEMessage,
      luzhangPositions: luzhangPositions,
      timestamp: Date.now()
    };
    fs.writeFileSync(path.join(__dirname, 'saved_game.json'), JSON.stringify(saveData, null, 2));
    io.emit('saveGameResult', { success: true });
    pendingFgReports = {};
    for (const [sid, sock] of io.sockets.sockets) {
      sock.emit('requestFgReport');
    }
    clearTimeout(fgReportTimer);
    fgReportTimer = setTimeout(() => {
      finalizeFgSave();
    }, 2000);
  });

  socket.on('fgReport', ({ areaF, areaG }) => {
    pendingFgReports[socket.id] = { areaF: areaF || '', areaG: areaG || '' };
  });

  function finalizeFgSave() {
    try {
      const savePath = path.join(__dirname, 'saved_game.json');
      const saveData = JSON.parse(fs.readFileSync(savePath, 'utf8'));
      saveData.areaFPerPlayer = {};
      saveData.areaGPerPlayer = {};
      for (const [sid, report] of Object.entries(pendingFgReports)) {
        const player = players.find(p => p.id === sid);
        if (player) {
          saveData.areaFPerPlayer[player.id] = report.areaF;
          saveData.areaGPerPlayer[player.id] = report.areaG;
        }
      }
      fs.writeFileSync(savePath, JSON.stringify(saveData, null, 2));
    } catch(e) {}
  }

  socket.on('deleteSaveGame', () => {
    const savePath = path.join(__dirname, 'saved_game.json');
    if (fs.existsSync(savePath)) {
      fs.unlinkSync(savePath);
      io.emit('deleteSaveGameResult', { success: true });
    } else {
      io.emit('deleteSaveGameResult', { success: false });
    }
  });

  socket.on('clearBottomBarOverlay', () => {
    // 触发者关闭TCK后，通知所有人清除bottomBar覆盖
    io.emit('clearBottomBarOverlay');
  });

  socket.on('clearBug', () => {
    // 清除所有面板和TCK
    io.emit('hideAllPanels');
    io.emit('hideTck');

    // 当前玩家的F区更新为结束
    const current = players[currentPlayerIndex];
    if (current) {
      const currentSocket = io.sockets.sockets.get(current.id);
      if (currentSocket) {
        currentSocket.emit('showEndTurn');
      }
    }

    // 清除所有状态
    pendingCardConfirm = null;
    baohuQueryState = null;
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
  });



  socket.on('loadGame', () => {
    const savePath = path.join(__dirname, 'saved_game.json');
    if (!fs.existsSync(savePath)) {
      socket.emit('loadGameResult', { success: false, error: '没有保存的游戏' });
      return;
    }
    try {
      const saveData = JSON.parse(fs.readFileSync(savePath, 'utf8'));
      players = saveData.players.map(p => ({ ...p }));
      board.forEach((s, i) => {
        if (saveData.board[i]) {
          s.name = saveData.board[i].name;
          s.type = saveData.board[i].type;
          s.isProperty = saveData.board[i].isProperty;
          s.price = saveData.board[i].price;
          s.rent = saveData.board[i].rent;
          s.owner = saveData.board[i].owner;
          s.houseLevel = saveData.board[i].houseLevel;
          s.closed = saveData.board[i].closed;
          s.displayName = saveData.board[i].displayName;
          s.rentBonus = saveData.board[i].rentBonus;
          s.airportType = saveData.board[i].airportType || null;
        }
      });
      gameState = saveData.gameState;
      currentPlayerIndex = saveData.currentPlayerIndex;
      selectedCharacters = saveData.selectedCharacters;
      currentDiceValue = saveData.currentDiceValue;
      roundCounter = saveData.roundCounter;
      diamondHolder = saveData.diamondHolder;
      diamondProgress = saveData.diamondProgress;
      diamondProgressPlayerId = saveData.diamondProgressPlayerId || null;
      diamondProgressPlayerColor = saveData.diamondProgressPlayerColor || null;
      rouletteRemaining = saveData.rouletteRemaining;
      kunlunState = saveData.kunlunState;
      dayunState = saveData.dayunState;
      zhadanState = saveData.zhadanState;
      fanzhuanState = saveData.fanzhuanState;
      xinlixueState = saveData.xinlixueState;
      lianhuanjiState = saveData.lianhuanjiState;
      sansiState = saveData.sansiState;
      qiyuState = saveData.qiyuState;
      jiyuQueue = saveData.jiyuQueue || [];
      xianzhiState = saveData.xianzhiState;
      tuisuanState = saveData.tuisuanState;
      jiandieState = saveData.jiandieState;
      tudijianbingState = saveData.tudijianbingState;
      chuanxiaoState = saveData.chuanxiaoState;
      meirenjiState = saveData.meirenjiState;
      jidiState = saveData.jidiState;
      xiaolicangdaoState = saveData.xiaolicangdaoState;
      hezongFirstPlayerId = saveData.hezongFirstPlayerId;
      if (saveData.lastAreaEMessage) lastAreaEMessage = saveData.lastAreaEMessage;
      if (saveData.luzhangPositions) luzhangPositions = saveData.luzhangPositions;
      loadedAreaFPerPlayer = saveData.areaFPerPlayer || {};
      loadedAreaGPerPlayer = saveData.areaGPerPlayer || {};
      loadedGameTotalPlayers = players.filter(p => !p.bankrupt).length;
      io.emit('loadGameSuccess', { players, board, gameState, currentPlayerIndex, selectedCharacters });
    } catch (e) {
      socket.emit('loadGameResult', { success: false, error: '载入失败' });
    }
  });

  socket.on('loadedGameSelectCharacter', ({ playerId, playerName, character, variant }) => {
    const player = players.find(p => p.id === playerId || p.name === playerName);
    if (player) {
      const oldId = player.id;
      player.id = socket.id;
      loadedGameSelectedCount++;
      
      board.forEach(s => {
        if (s.owner === oldId) {
          s.owner = socket.id;
        }
      });

      // 更新全局状态中记录的旧playerId
      if (kunlunState && kunlunState.playerId === oldId) {
        kunlunState.playerId = socket.id;
      }
      if (dayunState && dayunState.playerId === oldId) {
        dayunState.playerId = socket.id;
      }
      if (zhadanState && zhadanState.ownerId === oldId) {
        zhadanState.ownerId = socket.id;
      }
      if (pendingCardConfirm && pendingCardConfirm.playerId === oldId) {
        pendingCardConfirm.playerId = socket.id;
      }
      if (sansiState && sansiState.playerId === oldId) {
        sansiState.playerId = socket.id;
      }
      if (qiyuState && qiyuState.playerId === oldId) {
        qiyuState.playerId = socket.id;
      }
      if (diamondProgressPlayerId === oldId) {
        diamondProgressPlayerId = socket.id;
      }
      if (diamondHolder === oldId) {
        diamondHolder = socket.id;
      }

      socket.emit('loadedGameCharacterSelected', { playerId: player.id, playerName: player.name });
      io.emit('loadedGameCharacterTaken', { playerId, playerName });

      const fHtml = loadedAreaFPerPlayer[oldId];
      const gHtml = loadedAreaGPerPlayer[oldId];
      if (fHtml) socket.emit('restoreAreaF', { html: fHtml });
      if (gHtml) socket.emit('restoreAreaG', { html: gHtml });

      
      if (loadedGameSelectedCount >= loadedGameTotalPlayers) {
        io.emit('loadedGameAllSelected');
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter, kunlunState, dayunState, zhadanState });
        io.emit('diamondProgressUpdate', { playerId: diamondProgressPlayerId, playerColor: diamondProgressPlayerColor, progress: diamondProgress });
        if (kunlunState) {
          io.emit('kunlunArrive', { playerId: kunlunState.playerId, playerName: kunlunState.playerName, playerColor: kunlunState.playerColor, progress: kunlunState.progress });
        }
        if (lastAreaEMessage) {
          io.emit('updateAreaE', { message: lastAreaEMessage });
        }
        luzhangPositions.forEach(pos => {
          io.emit('luzhangPlaced', { position: pos });
        });
        const cur = players[currentPlayerIndex];
        if (cur && !cur.bankrupt) {
          const curSocket = io.sockets.sockets.get(cur.id);
          if (curSocket) {
            if (currentDiceValue > 0) {
              const curSpace = board[cur.position];
              if (curSpace && curSpace.type === 'property' && curSpace.owner === cur.id) {
                if (curSpace.name === '机场') {
                  curSocket.emit('airportChoice', {
                    spaceName: curSpace.displayName || curSpace.name,
                    houseLevel: curSpace.houseLevel,
                    buildCost: Math.floor(curSpace.price / 3),
                    airportType: curSpace.airportType || null,
                    spaceId: curSpace.id
                  });
                } else if (['五岳','泰山','嵩山','恒山','衡山','华山'].includes(curSpace.name)) {
                  curSocket.emit('wuyueChoice', {
                    spaceName: curSpace.name,
                    houseLevel: curSpace.houseLevel,
                    buildCost: Math.floor(curSpace.price / 3),
                    spaceId: curSpace.id
                  });
                } else {
                  curSocket.emit('showEndTurn');
                }
              } else {
                curSocket.emit('showEndTurn');
              }
            } else {
              startCurrentTurn();
            }
          }
        }
        loadedGameSelectedCount = 0;
        loadedGameTotalPlayers = 0;
      }
    }
  });

  socket.on('reconnectPlayer', ({ playerId, playerName }) => {
    const player = players.find(p => p.id === playerId || p.name === playerName);
    if (player) {
      const oldId = player.id;
      player.id = socket.id;
      myId = socket.id;
      board.forEach(s => { if (s.owner === oldId) s.owner = socket.id; });
      socket.emit('reconnectSuccess', { playerId: player.id, playerName: player.name });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      if (diceRolled && players[currentPlayerIndex]?.id === player.id) {
        socket.emit('showEndTurn');
      }
    }
  });

  function triggerKunlunPanel(kunlunPlayer) {
    const weightedOptions = [
      { name: '+4', weight: 2 },
      { name: '+3', weight: 2 },
      { name: '工资+1', weight: 2 },
      { name: '每人给你2', weight: 2 },
      { name: '解冻', weight: 2 },
      { name: '免休卡+1', weight: 2 },
      { name: '再动一次', weight: 2 },
      { name: '昆仑之门【需钥匙】：+40', weight: 1 },
      { name: '每人给你3', weight: 1 },
      { name: '+6', weight: 1 },
      { name: '+5', weight: 1 },
      { name: '骰子+1', weight: 1 },
      { name: '工资+2', weight: 1 },
      { name: '随机移除自己1项状态', weight: 1 },
      { name: '临时金钱+10', weight: 1 }
    ];
    const expanded = [];
    weightedOptions.forEach(opt => {
      for (let i = 0; i < opt.weight; i++) {
        expanded.push(opt.name);
      }
    });
    const shuffled = expanded.sort(() => Math.random() - 0.5);
    const randomOption1 = shuffled[0];
    let randomOption2 = shuffled[1];
    // 确保两个选项不同
    while (randomOption2 === randomOption1 && shuffled.length > 1) {
      shuffled.splice(1, 1);
      randomOption2 = shuffled[1] || randomOption1;
    }
    const options = [randomOption1, randomOption2];
    io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
    io.emit('bAreaOverlay', { imageSrc: '/drawable/ditu/kunlun.png' });
    io.emit('kunlunPanel', {
      playerId: kunlunPlayer.id,
      playerName: kunlunPlayer.name,
      playerColor: kunlunPlayer.color,
      options: options
    });
  }

  function startCurrentTurn() {
    updateShelteredState();
    diceRolled = false;
    const current = players[currentPlayerIndex];

    // 灾厄处理：回合开始时随机抽取灾厄效果
    if (current?.zaie && current.zaie > 0) {
      current.zaie--;
      const zaieEffect = weightedRandomZaie();
      const beforeFrozen = current.frozen || 0;
      const effectDesc = zaieEffect.effect(current);
      if ((current.frozen || 0) > beforeFrozen) {
        checkPassivePetSkill(current, 'frozen');
      }
      if (current.zaie <= 0) delete current.zaie;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      if (effectDesc === 'rest') {
        current.restTurns = (current.restTurns || 0) + 1;
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}受到灾厄，休息1回合` });
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        return;
      }
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}受到灾厄，${effectDesc}` });
    }

    players.forEach(p => {
      if (p.bomingFrozenUntil === players[currentPlayerIndex]?.id) {
        delete p.bomingFrozen;
        delete p.bomingFrozenUntil;
      }
    });
    
    if (current?.cunqianList && current.cunqianList.length > 0) {
      const expired = [];
      for (let i = 0; i < current.cunqianList.length; i++) {
        current.cunqianList[i]--;
        if (current.cunqianList[i] <= 0) {
          expired.push(i);
        }
      }
      if (expired.length > 0) {
        const bonus = expired.length * 50;
        previewMoney(current.id, bonus);
        current.cunqianList = current.cunqianList.filter((_, i) => !expired.includes(i));
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        io.emit('popupMessage', { message: `${coloredName(current.name, current.color)}存钱到期${expired.length > 1 ? `×${expired.length}` : ''}，+${bonus}` });
        io.emit('cunqianExpired', { playerId: current.id });
      } else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        io.emit('cunqianRoundUpdate', { playerId: current.id, rounds: current.cunqianList });
      }
    }
    
    if (current?.jinzu) {
      const jinzuBy = players.find(p => p.id === current.jinzu);
      current.jinzuStayTurn = true;
      delete current.jinzu;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}被${coloredName(jinzuBy?.name || '某人', jinzuBy?.color || '#fff')}禁足，停留原地` });
      const currentSocket = io.sockets.sockets.get(current.id);
      if (currentSocket) {
        currentSocket.emit('jinzuStay');
        handleDiceLanding(currentSocket, current, current.position, current.position);
      }
      return;
    }
    
    if (current?.bankrupt) {
      nextTurn();
      return;
    }

    if (zhadanState) {
      const owner = players.find(p => p.id === zhadanState.ownerId);
      const shouldCountDown = !owner || owner.bankrupt || zhadanState.ownerId === current?.id;
      if (shouldCountDown) {
        zhadanState.turnsLeft--;
        if (zhadanState.turnsLeft <= 0) {
          const bombPos = zhadanState.position;
          const bombRow = Math.floor(bombPos / 6);
          const hitMsgs = [];
          const rowMsgs = [];
          players.forEach(p => {
            if (p.bankrupt) return;
            if (p.position === bombPos) {
              previewMoney(p.id, -24);
              setPlayerState(p, 'inJail', true);
              p.jailState = 'hospital';
              hitMsgs.push(coloredName(p.name, p.color));
            } else if (Math.floor(p.position / 6) === bombRow) {
              previewMoney(p.id, -4);
              applyRest(p.id, 1, `${coloredName(p.name, p.color)}休息1回合`, null);
              rowMsgs.push(coloredName(p.name, p.color));
            }
          });
          zhadanState = null;
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, zhadanState });
          if (hitMsgs.length > 0 || rowMsgs.length > 0) {
            const parts = [];
            if (hitMsgs.length > 0) parts.push(`${hitMsgs.join('，')}被炸弹-24并炸进医院`);
            if (rowMsgs.length > 0) parts.push(`${rowMsgs.join('，')}被炸弹-4并休息1回合`);
            io.emit('updateAreaE', { message: parts.join('，') });
          } else {
            io.emit('updateAreaE', { message: '哑弹，无人受伤' });
          }
          startCurrentTurn();
          return;
        } else if (zhadanState.turnsLeft === 1) {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, zhadanState });
        }
      }
    }

    if (dayunState && dayunState.active && dayunState.playerId === current?.id) {
      const startPos = dayunState.position;
      const roll = Math.floor(Math.random() * 6) + 1;
      const boardSize = board.length;
      const endPos = (startPos + roll) % boardSize;
      const passedSpaces = [];
      for (let i = 1; i <= roll; i++) {
        passedSpaces.push((startPos + i) % boardSize);
      }
      const passedButNotEnd = passedSpaces.slice(0, -1);
      const dayunOwner = players.find(p => p.id === dayunState.playerId);
      io.emit('dayunMove', { startPos, endPos, roll, passedSpaces, ownerName: dayunOwner?.name, ownerColor: dayunOwner?.color });
      const animDelay = 500 + roll * 400 + 500;
      setTimeout(() => {
        const passMsgs = [];
        const hitMsgs = [];
        passedButNotEnd.forEach(spaceId => {
          const spacePlayers = players.filter(p => p.position === spaceId && !p.bankrupt && !p.inJail && p.position !== endPos);
          spacePlayers.forEach(p => {
            previewMoney(p.id, -4);
            p.restTurns += 1;
            passMsgs.push(`${coloredName(p.name, p.color)}-4并休息`);
          });
        });
        const endPlayers = players.filter(p => p.position === endPos && !p.bankrupt && !p.inJail);
        if (endPlayers.length > 0) {
          const processDayunHit = (index) => {
            if (index >= endPlayers.length) {
              dayunState = null;
              const parts = [];
              if (passMsgs.length > 0) parts.push('大运经过' + passMsgs.join('，'));
              if (hitMsgs.length > 0) parts.push('大运撞倒' + hitMsgs.join('，'));
              if (parts.length === 0) parts.push(`大运从${board[startPos].name}移动${roll}步到${board[endPos].name}，无人受伤`);
              io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, dayunState });
              io.emit('updateAreaE', { message: parts.join('；') });
              startCurrentTurn();
              return;
            }
            const p = endPlayers[index];
            previewMoney(p.id, -8);
            sendToHospital(p.id, '大运车撞伤', () => {
              hitMsgs.push(`${coloredName(p.name, p.color)}-8进医院`);
              processDayunHit(index + 1);
            });
          };
          processDayunHit(0);
        } else {
          dayunState = null;
          const parts = [];
          if (passMsgs.length > 0) parts.push('大运经过' + passMsgs.join('，'));
          if (hitMsgs.length > 0) parts.push('大运撞倒' + hitMsgs.join('，'));
          if (parts.length === 0) parts.push(`大运从${board[startPos].name}移动${roll}步到${board[endPos].name}，无人受伤`);
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, dayunState });
          io.emit('updateAreaE', { message: parts.join('；') });
          startCurrentTurn();
        }
      }, animDelay);
      return;
    }
    if (current?.mammothFrozenBy || current?.mammothSelfFrozen) {
      const roll = Math.floor(Math.random() * 6) + 1;
      const s = io.sockets.sockets.get(current.id);
      const mammothMsg = (r, released) => released
        ? `${coloredName(current.name, current.color)}判定为${r}，解除寒冰猛犸的封冻`
        : `${coloredName(current.name, current.color)}判定${r}，被寒冰猛犸冻住`;
      const doMammothRelease = (r) => {
        delete current.mammothFrozenBy;
        delete current.mammothSelfFrozen;
        io.emit('turnUpdate', { players, board, currentPlayerIndex, message: mammothMsg(r, true), currentDiceValue, roundCounter });
        if (s) s.emit('mammothFrozenRelease');
      };
      const doMammothStay = (r) => {
        io.emit('turnUpdate', { players, board, currentPlayerIndex, message: mammothMsg(r, false), currentDiceValue, roundCounter });
        if (s) s.emit('mammothFrozenStay');
      };
      const doMammothJudge = () => {
        const newRoll = Math.floor(Math.random() * 6) + 1;
        if (newRoll >= 4) doMammothRelease(newRoll);
        else doMammothStay(newRoll);
      };
      const originalResult = () => {
        if (roll >= 4) doMammothRelease(roll);
        else doMammothStay(roll);
      };
      if (checkKoiOrDuogongnengJudge(current.id, doMammothJudge, originalResult)) {
        io.emit('turnUpdate', { players, board, currentPlayerIndex, message: mammothMsg(roll, roll >= 4) + '，是否重新判定？', currentDiceValue, roundCounter });
        return;
      }
      if (roll >= 4) doMammothRelease(roll);
      else doMammothStay(roll);
      if (roll < 4) return;
    }

    if (current?.shihua) {
      const roll = Math.floor(Math.random() * 6) + 1;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      const s = io.sockets.sockets.get(current.id);
      const doShihuaJudge = () => {
        const newRoll = Math.floor(Math.random() * 6) + 1;
        if (newRoll >= 5) {
          current.shihua = false;
          io.emit('updateAreaE', { message: `判定为${newRoll}，解除石化` });
          if (s) s.emit('shihuaEnd');
        } else {
          io.emit('updateAreaE', { message: `判定${newRoll}，石化中...` });
          if (s) s.emit('shihuaContinue');
          return;
        }
      };
      const originalResult = () => {
        if (roll >= 5) {
          current.shihua = false;
          io.emit('updateAreaE', { message: `判定为${roll}，解除石化` });
          if (s) s.emit('shihuaEnd');
        } else {
          io.emit('updateAreaE', { message: `判定${roll}，石化中...` });
          if (s) s.emit('shihuaContinue');
          return;
        }
      };
      if (checkKoiOrDuogongnengJudge(current.id, doShihuaJudge, originalResult)) {
        io.emit('updateAreaE', { message: `判定为${roll}，${roll >= 5 ? '解除石化' : '石化中'}，是否重新判定？` });
        return;
      }
      if (roll >= 5) {
        current.shihua = false;
        io.emit('updateAreaE', { message: `判定为${roll}，解除石化` });
        if (s) s.emit('shihuaEnd');
      } else {
        io.emit('updateAreaE', { message: `判定${roll}，石化中...` });
        if (s) s.emit('shihuaContinue');
        return;
      }
    }
    const currentSpace = board[current?.position];
    if (currentSpace && currentSpace.name === '断桥' && !current.inJail) {
      const roll = Math.floor(Math.random() * 6) + 1;
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      if (roll <= 3) {
        io.emit('updateAreaE', { message: `判定为${roll}，无法通过断桥` });
        io.emit('clearAreaG', { playerId: current.id });
        io.emit('showEndTurn');
        return;
      } else {
        io.emit('updateAreaE', { message: `判定为${roll}，请通过断桥` });
      }
    }
    if (current?.bingdong > 0) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter, bingdongProcessing: true });
      io.emit('clearAreaG', { playerId: current.id });
      current.bingdong--;
      const curSpace = board[current.position];
      // 发送TIP显示冰冻消息
      io.emit('showTip', { imgSrc: 'bingdong', text: `${coloredName(current.name, current.color)}冰冻中，停留1回合` });
      if (curSpace) {
        handleDiceLanding(io.sockets.sockets.get(current.id), current, current.position, current.position);
      } else {
        io.emit('showEndTurn');
      }
      return;
    }
    if (current?.restTurns > 0) {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      if (current.shelteredTurns > 0) {
        current.shelteredTurns--;
        updateShelteredState();
      }
      current.restTurns--;
      io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}休息1回合` });
      io.emit('showEndTurn');
      return;
    }
    if (current?.shelteredTurns > 0) {
      current.shelteredTurns--;
      updateShelteredState();
    }
    if (current?.hezongState === 'forced') {
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
      io.emit('updateAreaE', { message: `停留此处直到2人合纵，还剩${current.hezongTurns}回合` });
      current.hezongTurns--;
      if (current.hezongTurns <= 0) {
        current.hezongState = 'normal';
        current.hezongTurns = 0;
      }
      io.to(current.id).emit('hezongForced');
      return;
    }
    if (current?.hezongState === 'normal') {
      current.hezongTurns++;
      if (current.hezongTurns >= 2) {
        current.hezongState = null;
        current.hezongTurns = 0;
        const hezongSpace3 = board.find(s => s.type === 'hezong');
        const hezongPos3 = hezongSpace3 ? hezongSpace3.id : 30;
        const otherHezong = players.find(p => p.id !== current.id && p.position === hezongPos3 && (p.hezongState === 'forced' || p.hezongState === 'normal'));
        if (otherHezong) {
          otherHezong.hezongState = null;
          otherHezong.hezongTurns = 0;
        }
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        io.emit('updateAreaE', { message: `合纵失败，无人合纵` });
        io.to(current.id).emit('hezongTimeout');
      } else {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        io.emit('updateAreaE', { message: `可停留此处，直到2人合纵（剩余${2 - current.hezongTurns}回合）` });
        io.to(current.id).emit('hezongNormal');
      }
      return;
    }
    if (current?.inJail) {
      if (current.jailState === 'justJailed') {
        // 栽赃等原因刚进监狱，显示监狱面板
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        const msg = `${coloredName(current.name, current.color)}在监狱`;
        io.emit('showJailMap', { players, board, currentPlayerIndex, message: msg, currentDiceValue });
        const currentSocket = io.sockets.sockets.get(current.id);
        if (currentSocket) currentSocket.emit('showEndTurn');
        return;
      } else if (current.jailState === 'jail') {
        // 在监狱中，显示监狱面板（判定/保释）
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        const msg = `${coloredName(current.name, current.color)}在监狱`;
        io.emit('showJailMap', { players, board, currentPlayerIndex, message: msg, currentDiceValue });
        return;
      } else if (current.jailState === 'hospital') {
        current.jailState = 'health';
        current.position = JAIL_FREE_ID;
        io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}康复`, currentDiceValue, roundCounter });
        return;
      } else if (current.jailState === 'island') {
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        io.emit('clearAreaG', { playerId: current.id });
        const msg = `${coloredName(current.name, current.color)}在海南`;
        io.emit('showJailMap', { players, board, currentPlayerIndex, message: msg, currentDiceValue });
        const roll = Math.floor(Math.random() * 6) + 1;
        currentDiceValue = roll;
        if (roll === 1) {
          const targetPos = Math.floor(Math.random() * BOARD_SIZE);
          current.position = targetPos;
          current.inJail = false;
          current.jailState = null;
          const targetSpace = board[targetPos];
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
          io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `随机弹飞到${targetSpace.name}`, currentDiceValue });
          io.emit('showEndTurn');
          return;
        } else if (roll === 2) {
          current.jailState = 'islandTreasure';
          const maze = generateMazeServer();
          io.emit('updateAreaE', { message: `寻宝` });
          io.emit('islandTreasure', { playerId: current.id, playerName: current.name, playerColor: current.color, maze });
          const currentSocket = io.sockets.sockets.get(current.id);
          if (currentSocket) currentSocket.emit('clearAreaF');
          return;
        } else if (roll === 3) {
          io.emit('updateAreaE', { message: `是否花16到医院` });
          io.emit('islandHospitalChoice', { playerId: current.id });
          return;
        } else if (roll === 4) {
          io.emit('updateAreaE', { message: `吃螃蟹度过了一天` });
          io.emit('showEndTurn');
          return;
        } else if (roll === 5) {
          io.emit('updateAreaE', { message: `吃鱼度过了一天` });
          io.emit('showEndTurn');
          return;
        } else if (roll === 6) {
          islandSwapBids = {};
          io.emit('updateAreaE', { message: `求援与他人换位，其他人请报价...` });
          const currentSocket = io.sockets.sockets.get(current.id);
          if (currentSocket) currentSocket.emit('clearAreaF');
          io.emit('islandSwapStart', { playerId: current.id, playerName: current.name, playerColor: current.color });
          return;
        }
      } else if (current.jailState === 'islandTreasure') {
        const maze = generateMazeServer();
        io.emit('updateAreaE', { message: `${coloredName(current.name, current.color)}正在寻宝` });
        io.emit('islandTreasure', { playerId: current.id, playerName: current.name, playerColor: current.color, maze });
        const currentSocket = io.sockets.sockets.get(current.id);
        if (currentSocket) currentSocket.emit('clearAreaF');
        return;
      } else if (current.jailState === 'health') {
        current.position = 1;
        current.inJail = false;
        current.jailState = null;
        io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
        io.emit('turnUpdate', { players, board, currentPlayerIndex, message: `${coloredName(current.name, current.color)}出狱`, currentDiceValue: -1 });
        socket.emit('showEndTurn');
        return;
      }
    }

    if (kunlunState && kunlunState.playerId === current?.id) {
      if (kunlunState.progress >= 7) {
        kunlunFromTurn = true;
        triggerKunlunPanel(current);
        return;
      }
      io.emit('kunlunProgress', {
        playerId: current.id,
        progress: kunlunState.progress
      });
    } else if (kunlunState) {
    }

    // 吸血蚊：其他玩家回合开始时的被动触发
    const xixuewenOwner = players.find(p => !p.bankrupt && p.petImage && getPetInfo(p.petImage)?.name === '吸血蚊' && !p.petFlipped && p.id !== current.id);
    if (xixuewenOwner) {
      // 广播B区覆盖给所有玩家
      io.emit('xixuewenOverlay', { ownerName: xixuewenOwner.name, ownerColor: xixuewenOwner.color });
      const currentSocket = io.sockets.sockets.get(current.id);
      if (currentSocket) {
        currentSocket.emit('xixuewenTck', {
          ownerId: xixuewenOwner.id,
          ownerName: xixuewenOwner.name,
          ownerColor: xixuewenOwner.color
        });
        return;
      }
    }

    io.emit('turnUpdate', { players, board, currentPlayerIndex, currentDiceValue, roundCounter });

    if (current.cicadaActive && current.cicadaCount < 3) {
      const currentSocket = io.sockets.sockets.get(current.id);
      if (currentSocket) currentSocket.emit('cicadaTurnStart');
    }
  }

  function nextTurn() {
    currentDiceValue = 0;
    diceRolled = false;
    const prevIndex = currentPlayerIndex;
    do {
      currentPlayerIndex = (currentPlayerIndex + 1) % players.length;
    } while (players[currentPlayerIndex]?.bankrupt);

    if (currentPlayerIndex === 0 && prevIndex !== 0) {
      roundCounter++;
      // 每轮所有玩家的古董卡价格+1
      players.forEach(p => {
        if (!p.bankrupt && p.cards) {
          p.cards.forEach(c => {
            if (c.name === '古董卡') {
              if (!c.price) c.price = 1;
              c.price++;
              c.description = `古董卡：当前价格${c.price}，每轮价格+1，点击使用即卖出`;
            }
          });
        }
      });
      if (kunlunState) {
        kunlunState.progress++;
        io.emit('kunlunProgress', {
          playerId: kunlunState.playerId,
          progress: kunlunState.progress
        });
        // 昆仑进度满时立即触发TCK，即使玩家在休息
        if (kunlunState.progress >= 7) {
          const kunlunPlayer = players.find(p => p.id === kunlunState.playerId);
          if (kunlunPlayer && !kunlunPlayer.bankrupt) {
            kunlunFromTurn = false;
            triggerKunlunPanel(kunlunPlayer);
            return;
          }
        }
      }
      if (roundCounter % 10 === 0) {
        players.forEach(p => {
          if (!p.bankrupt) {
            if (p.frozen > 0) {
              previewMoney(p.id, p.frozen);
              p.frozen = 0;
            }
            previewMoney(p.id, p.salary);
            p.petFlipped = false;
            if (p.petImage) {
              const info = getPetInfo(p.petImage);
              if (info && info.name === '影魔') p.yingmoCharges = 3;
            }
            delete p.wolfMark;
          }
        });
        io.emit('showSalaryPanel', { players, round: roundCounter });
        players.forEach(p => {
          if (!p.bankrupt && p.loans && p.loans.length > 0) {
            p.loans.forEach(loan => {
              if (loan.remaining > 0) {
                previewMoney(p.id, -loan.installment);
                loan.remaining--;
              }
            });
            p.loans = p.loans.filter(l => l.remaining > 0);
          }
        });
        setTimeout(() => {
          io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, roundCounter });
          startCurrentTurn();
        }, 800);
        return;
      }
    }
    startCurrentTurn();
  }

  const TEMP_SAVE_PATH = path.join(__dirname, 'temp_saved_game.json');

  function saveTempGame() {
    try {
      const data = {
        players: JSON.parse(JSON.stringify(players.map(p => {
          const { connected, ...rest } = p;
          return rest;
        }))),
        board: board.map(s => ({
          id: s.id, name: s.name, type: s.type, isProperty: s.isProperty,
          price: s.price, rent: s.rent, owner: s.owner, houseLevel: s.houseLevel,
          closed: s.closed, displayName: s.displayName, rentBonus: s.rentBonus,
          airportType: s.airportType || null
        })),
        gameState, currentPlayerIndex, selectedCharacters, currentDiceValue, diceRolled, roundCounter,
        diamondHolder: diamondHolder, diamondProgress, diamondProgressPlayerId, diamondProgressPlayerColor,
        rouletteRemaining, kunlunState, dayunState, zhadanState, fanzhuanState, xinlixueState,
        lianhuanjiState, sansiState, qiyuState, jiyuQueue, xianzhiState, tuisuanState,
        jiandieState, tudijianbingState, chuanxiaoState, meirenjiState, jidiState,
        xiaolicangdaoState, hezongFirstPlayerId, lastAreaEMessage, luzhangPositions,
        timestamp: Date.now()
      };
      fs.writeFileSync(TEMP_SAVE_PATH, JSON.stringify(data, null, 2));
    } catch(e) { console.error('saveTempGame error:', e.message); }
  }

  function loadTempGame() {
    if (!fs.existsSync(TEMP_SAVE_PATH)) return false;
    try {
      const d = JSON.parse(fs.readFileSync(TEMP_SAVE_PATH, 'utf8'));
      players = d.players.map(p => ({ ...p }));
      board.forEach((s, i) => { if (d.board[i]) Object.assign(s, d.board[i]); });
      gameState = d.gameState; currentPlayerIndex = d.currentPlayerIndex;
      selectedCharacters = d.selectedCharacters; currentDiceValue = d.currentDiceValue;
      diceRolled = d.diceRolled || false; roundCounter = d.roundCounter; diamondHolder = d.diamondHolder;
      diamondProgress = d.diamondProgress; diamondProgressPlayerId = d.diamondProgressPlayerId;
      diamondProgressPlayerColor = d.diamondProgressPlayerColor;
      rouletteRemaining = d.rouletteRemaining; kunlunState = d.kunlunState;
      dayunState = d.dayunState; zhadanState = d.zhadanState;
      fanzhuanState = d.fanzhuanState; xinlixueState = d.xinlixueState;
      lianhuanjiState = d.lianhuanjiState; sansiState = d.sansiState;
      qiyuState = d.qiyuState; jiyuQueue = d.jiyuQueue || [];
      xianzhiState = d.xianzhiState; tuisuanState = d.tuisuanState;
      jiandieState = d.jiandieState; tudijianbingState = d.tudijianbingState;
      chuanxiaoState = d.chuanxiaoState; meirenjiState = d.meirenjiState;
      jidiState = d.jidiState; xiaolicangdaoState = d.xiaolicangdaoState;
      hezongFirstPlayerId = d.hezongFirstPlayerId;
      if (d.lastAreaEMessage) lastAreaEMessage = d.lastAreaEMessage;
      if (d.luzhangPositions) luzhangPositions = d.luzhangPositions;
      return true;
    } catch(e) { return false; }
  }

  function deleteTempSave() {
    try { if (fs.existsSync(TEMP_SAVE_PATH)) fs.unlinkSync(TEMP_SAVE_PATH); } catch(e) {}
  }

  socket.on('disconnect', () => {
    const player = players.find(p => p.id === socket.id);
    if (player) {
      savePlayerTemporaryData(socket.id);
      player.connected = false;
      disconnectedPlayers[player.id] = { name: player.name, color: player.color };
      io.emit('showDisconnectOverlay', { playerName: player.name, playerColor: player.color, reason: '离线' });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      if (gameState === 'playing') {
        saveTempGame();
      }
    }
  });

  socket.on('reconnectPlayer', ({ playerId, playerName }) => {
    let player = players.find(p => p.id === playerId);
    if (!player) {
      player = players.find(p => p.name === playerName);
    }
    if (!player && fs.existsSync(TEMP_SAVE_PATH)) {
      if (loadTempGame()) {
        player = players.find(p => p.id === playerId || p.name === playerName);
      }
    }
    const loadedFromTemp = !!(player && fs.existsSync(TEMP_SAVE_PATH));
    if (player) {
      const oldId = player.id;
      player.connected = true;
      player.id = socket.id;
      board.forEach(s => { if (s.owner === oldId) s.owner = socket.id; });
      if (kunlunState && kunlunState.playerId === oldId) {
        kunlunState.playerId = socket.id;
      }
      if (dayunState && dayunState.playerId === oldId) {
        dayunState.playerId = socket.id;
      }
      if (zhadanState && zhadanState.ownerId === oldId) {
        zhadanState.ownerId = socket.id;
      }
      if (sansiState && sansiState.playerId === oldId) {
        sansiState.playerId = socket.id;
      }
      if (qiyuState && qiyuState.playerId === oldId) {
        qiyuState.playerId = socket.id;
      }
      if (diamondProgressPlayerId === oldId) {
        diamondProgressPlayerId = socket.id;
      }
      if (diamondHolder === oldId) {
        diamondHolder = socket.id;
      }
      io.emit('playerReconnected', { playerId: player.id, playerName: player.name });
      io.emit('sync', { players, board, gameState, currentPlayerIndex, selectedCharacters, currentDiceValue });
      if (diceRolled && players[currentPlayerIndex]?.id === player.id) {
        const cur = players[currentPlayerIndex];
        const curSpace = board[cur?.position];
        if (curSpace && curSpace.type === 'property' && curSpace.owner === cur.id) {
          if (curSpace.name === '机场') {
            socket.emit('airportChoice', {
              spaceName: curSpace.displayName || curSpace.name,
              houseLevel: curSpace.houseLevel,
              buildCost: Math.floor(curSpace.price / 3),
              airportType: curSpace.airportType || null,
              spaceId: curSpace.id
            });
          } else if (['五岳','泰山','嵩山','恒山','衡山','华山'].includes(curSpace.name)) {
            socket.emit('wuyueChoice', {
              spaceName: curSpace.name,
              houseLevel: curSpace.houseLevel,
              buildCost: Math.floor(curSpace.price / 3),
              spaceId: curSpace.id
            });
          } else {
            socket.emit('showEndTurn');
          }
        } else {
          socket.emit('showEndTurn');
        }
      }
      if (loadedFromTemp) {
        const cur = players[currentPlayerIndex];
        if (cur && !cur.bankrupt) {
          const curSocket = io.sockets.sockets.get(cur.id);
          if (curSocket) {
            if (currentDiceValue > 0) {
              const curSpace = board[cur.position];
              if (curSpace && curSpace.type === 'property' && curSpace.owner === cur.id) {
                if (curSpace.name === '机场') {
                  curSocket.emit('airportChoice', {
                    spaceName: curSpace.displayName || curSpace.name,
                    houseLevel: curSpace.houseLevel,
                    buildCost: Math.floor(curSpace.price / 3),
                    airportType: curSpace.airportType || null,
                    spaceId: curSpace.id
                  });
                } else if (['五岳','泰山','嵩山','恒山','衡山','华山'].includes(curSpace.name)) {
                  curSocket.emit('wuyueChoice', {
                    spaceName: curSpace.name,
                    houseLevel: curSpace.houseLevel,
                    buildCost: Math.floor(curSpace.price / 3),
                    spaceId: curSpace.id
                  });
                } else {
                  curSocket.emit('showEndTurn');
                }
              } else {
                curSocket.emit('showEndTurn');
              }
            } else {
              startCurrentTurn();
            }
          }
        }
      }
    }
  });
});

if (IS_CLOUD) {
  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
} else {
  httpsServer.listen(3000, '0.0.0.0', () => {
    console.log('HTTPS Server running on port 3000');
  });
  httpServer.listen(3001, '0.0.0.0', () => {
    console.log('HTTP Server running on port 3001');
  });
}

// ─── 空闲自动回收（仅云部署） ──────────────────────────────
let shutdownTimer = null;
if (IS_CLOUD) {
  io.on('connection', () => {
    if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
  });
  setInterval(() => {
    const count = io.engine?.clientsCount || 0;
    if (count === 0 && !shutdownTimer) {
      shutdownTimer = setTimeout(() => {
        console.log('[空闲回收] 10分钟无连接，即将关闭');
        process.exit(0);
      }, 10 * 60 * 1000);
    } else if (count > 0 && shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
  }, 60 * 1000);
}