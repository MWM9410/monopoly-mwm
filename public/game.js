// 控制台日志捕获
const _consoleLogs = [];
const _maxLogs = 200;
const _origConsole = { log: console.log, warn: console.warn, error: console.error };
function _captureLog(level, args) {
  const msg = Array.from(args).map(a => { try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch(e) { return String(a); } }).join(' ');
  _consoleLogs.push(`[${level}] ${msg}`);
  if (_consoleLogs.length > _maxLogs) _consoleLogs.shift();
}
console.log = function() { _captureLog('LOG', arguments); _origConsole.log.apply(console, arguments); };
console.warn = function() { _captureLog('WARN', arguments); _origConsole.warn.apply(console, arguments); };
console.error = function() { _captureLog('ERR', arguments); _origConsole.error.apply(console, arguments); };

// 代理 socket - 兼容 socket.io API，底层由 GameNet 驱动
const socket = {
  _real: null,
  _pendingOns: [],
  _connected: false,
  id: null,

  _init(real) {
    this._real = real;
    this.id = real.id;
    this._connected = true;
    // 迁移所有 pending handlers
    for (const [ev, cb] of this._pendingOns.splice(0)) {
      real.on(ev, cb);
    }
  },

  on(ev, cb) {
    if (this._real) { this._real.on(ev, cb); }
    else { this._pendingOns.push([ev, cb]); }
    return this;
  },

  emit(ev, data) {
    if (this._real) { this._real.emit(ev, data); }
  },

  off(ev, cb) {
    if (this._real && this._real.off) this._real.off(ev, cb);
  },
  disconnect() {
    // WebRTC 断开 - 交由 GameNet 处理
    if (window.GameNet && window.GameNet._closeAll) GameNet._closeAll();
    this._connected = false;
  }
};

// 房间连接逻辑（房间列表模式）
(function() {
  const $ = (id) => document.getElementById(id);

  const connectScreen = $('connectScreen');
  const lobby = $('lobby');
  const signalUrlInput = $('signalUrlInput');
  const createRoomBtn = $('createRoomBtn');
  const roomListEl = $('roomList');
  const connectStatus = $('connectStatus');
  const roomCodeDisplay = $('roomCodeDisplay');

  // 根据当前页面地址自动推断信号服务器地址
  // 例如页面在 http://192.168.110.68:8080 打开 → ws://192.168.110.68:3001
  // Cloudflare Pages 部署时使用默认的 Worker 地址
  (function initSignalUrl() {
    try {
      const loc = new URL(location.href);
      if (loc.hostname && loc.hostname !== 'localhost' && loc.hostname !== '127.0.0.1') {
        // Cloudflare Pages/Woker 部署 → 使用默认 Worker 地址
        if (loc.hostname.endsWith('pages.dev') || loc.hostname.endsWith('workers.dev')) {
          signalUrlInput.value = 'wss://monopoly-signal.229344154.workers.dev';
        } else {
          // 本地局域网：用页面同 host，端口 3001
          const proto = (loc.protocol === 'https:' ? 'wss://' : 'ws://');
          const port = loc.port === '8080' ? '3001' : (loc.port || (proto === 'wss://' ? '443' : '80'));
          signalUrlInput.value = proto + loc.hostname + ':' + port;
        }
        signalUrlInput.placeholder = '信号服务器地址（默认 ' + signalUrlInput.value + '）';
      }
    } catch (e) {}
  })();

  let roomWatcher = null;
  let currentHost = null;

  function getSignalUrl() {
    // URL 参数 ?signal= 优先（部署时用）
    try {
      const params = new URLSearchParams(location.search);
      const sig = params.get('signal');
      if (sig) return sig.trim();
    } catch (e) {}
    let url = (signalUrlInput.value || 'ws://localhost:3001').trim();
    // 协议补全：用户可能只填域名
    if (!/^wss?:\/\//.test(url)) {
      // 生产环境（非 localhost）默认用 wss
      const useWss = !/localhost|127\.0\.0\.1|192\.168\./.test(url);
      url = (useWss ? 'wss://' : 'ws://') + url;
    }
    // 生产环境强制 wss（HTTPS 页面不允许 ws）
    if (url.startsWith('ws://') && !/localhost|127\.0\.0\.1|192\.168\./.test(url)) {
      url = 'wss://' + url.slice(5);
    }
    return url;
  }

  function setStatus(msg, isError) {
    connectStatus.textContent = msg;
    connectStatus.style.color = isError ? '#e94560' : '#4ecca3';
  }
  function showLobby() {
    connectScreen.style.display = 'none';
    lobby.classList.remove('hidden');
  }

  // 渲染房间列表
  function renderRoomList(rooms) {
    if (!rooms || rooms.length === 0) {
      roomListEl.innerHTML = '<div style="text-align:center;color:#666;padding:40px 0;font-size:14px;">暂无房间，点击下方创建</div>';
      return;
    }
    roomListEl.innerHTML = rooms.map(r => `
      <div class="room-card" data-code="${r.code}" style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:#16213e;border-radius:10px;cursor:pointer;border:1px solid #0f3460;transition:border-color 0.2s;"
           onmouseover="this.style.borderColor='#e94560'" onmouseout="this.style.borderColor='#0f3460'">
        <span style="flex:1;font-size:18px;font-weight:bold;letter-spacing:2px;color:#fff;">${r.code}</span>
        <span style="color:#888;font-size:14px;">👤 ${r.playerCount}/8</span>
      </div>
    `).join('');
    // 点击房间加入
    roomListEl.querySelectorAll('.room-card').forEach(el => {
      el.addEventListener('click', () => joinRoom(el.dataset.code));
    });
  }

  // ── 加入房间 ──
  async function joinRoom(code) {
    setStatus('正在加入房间...');
    try {
      const channel = await GameNet.joinRoom(getSignalUrl(), code);
      setStatus('已连接到主机');

      const clientSocket = {
        id: null,
        _handlers: {},
        on: function(ev, cb) {
          if (!this._handlers[ev]) this._handlers[ev] = [];
          this._handlers[ev].push(cb);
          return this;
        },
        emit: function(ev, data) { channel.emit(ev, data); },
        off: function() {}
      };
      socket._init(clientSocket);

      channel.on('*', (event, data) => {
        if (event === 'updatePlayers' && data) {
          const savedName = localStorage.getItem('monopoly_player_name');
          const me = data.find(p => p.name === savedName);
          if (me) { clientSocket.id = me.id; socket.id = me.id; }
        }
        const handlers = clientSocket._handlers[event] || [];
        for (const h of handlers) h(data);
      });

      showLobby();
      setTimeout(() => {
        const handlers = clientSocket._handlers['connect'] || [];
        for (const h of handlers) h();
      }, 100);

    } catch(e) {
      setStatus('加入房间失败: ' + e.message, true);
    }
  }

  // ── 创建房间 ──
  createRoomBtn.addEventListener('click', async () => {
    createRoomBtn.disabled = true;
    setStatus('正在创建房间...');
    try {
      currentHost = await GameNet.createHost(getSignalUrl());
      console.log('[DEBUG] Room created:', currentHost.roomCode);

      roomCodeDisplay.textContent = '房间码: ' + currentHost.roomCode;
      setStatus('等待玩家加入...');

      const setupHost = () => {
        console.log('[DEBUG] setupHost called, _ready=', window.GameEngine._ready);
        const initQueue = [];
        const hostSocket = GameEngine.createPlayerSocket('host_' + Date.now(), (event, data) => {
          if (!socket._real) { initQueue.push([event, data]); }
        });
        console.log('[DEBUG] hostSocket created:', hostSocket ? hostSocket.id : 'null');
        if (!hostSocket) { setStatus('引擎未就绪', true); createRoomBtn.disabled = false; return; }
        currentHost.registerHostSocket(hostSocket);
        socket._init(hostSocket);
        console.log('[DEBUG] Replaying', initQueue.length, 'events');
        for (const [ev, data] of initQueue) {
          const handlers = hostSocket._handlers[ev] || [];
          console.log('[DEBUG] Replay event:', ev, 'handlers:', handlers.length);
          for (const h of handlers) h(data);
        }
        showLobby();
        roomCodeDisplay.textContent = '房间码: ' + currentHost.roomCode;
        currentHost.on('peer_connected', () => setStatus('新玩家已加入！'));
        console.log('[DEBUG] Will fire connect in 100ms');
        setTimeout(() => {
          const handlers = hostSocket._handlers['connect'] || [];
          console.log('[DEBUG] Firing connect, handlers:', handlers.length);
          for (const h of handlers) h();
        }, 100);
      };

      if (window.GameEngine._ready) setupHost();
      else GameEngine.onEngineReady(setupHost);

    } catch(e) {
      setStatus('创建房间失败: ' + e.message, true);
      createRoomBtn.disabled = false;
    }
  });

  // ── 启动房间列表监听 ──
  roomWatcher = GameNet.watchRooms(getSignalUrl());
  roomWatcher.on('update', (rooms) => { renderRoomList(rooms); });
  // 信号服务器地址变化时重连
  signalUrlInput.addEventListener('change', () => {
    if (roomWatcher) roomWatcher.close();
    roomWatcher = GameNet.watchRooms(getSignalUrl());
    roomWatcher.on('update', (rooms) => { renderRoomList(rooms); });
  });

})();

{ // 作用域块，避免与 server-browser.js 的 let 声明冲突
let myId = null, players = [], board = [], currentPlayerIdx = 0, hasRolledThisTurn = false;
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
    ['汗血马','掷骰子点数变为3-7'],
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
const animatingPositions = new Map();
let isDisconnected = false;
let isLoadedGame = false;
let pendingLoadRender = false;
let luzhangPositions = [];
let selectingLuzhangPosition = false;
let selectingHezongTarget = false;
let selectingSwapTarget = false;
let selectingRouletteTarget = false;
let selectingStartTarget = false;
let startTargetIds = [];
let rouletteExcludedIds = [];
let selectingGuestTarget = false;
let selectingIslandSwapTarget = false;
let selectingJidiTarget = false;
let jidiAliveIds = [];
let selectingGaichaoTarget = false;
let selectingBaijinTarget = false;
let selectingNongminTarget = false;
let selectingQiyuTarget = false;
let selectingGuashaTarget = false;
let selectingJiaoyiTarget = false;
let selectingZemuerqiTarget = false;
let jiaoyiSelectingProp = false;
let selectingPaozhuanTarget = false;
let paozhuanSelectingProp = false;
let selectingYuanjiaoTargetA = false;
let selectingYuanjiaoTargetB = false;
let yuanjiaoTargetAId = null;
let selectingShunyiTarget = false;
let selectingQiangjieTarget = false;
let selectingLongjuanfengTarget = false;
let longjuanfengCanSelectSelf = false;
let selectingBingdongTarget = false;
let bingdongCanSelectSelf = false;
let selectingShanxianTarget = false;
let selectingChuansongTarget = false;
let selectingChuansongPlayerTarget = false;
let chuansongCanSelectSelf = false;
let selectingFengdiCardTarget = false;
let fengdiCardCanSelectSelf = false;
let selectingYingmoTarget = false;
let selectingTingyeTarget = false;
let tingyeCanSelectSelf = false;
let selectingHeikeTarget = false;
let selectingJinghuaTarget = false;
let selectingPetShopEmptyProp = false;
let heikeCanSelectSelf = false;
let qiyuAnmianyaoSelecting = false;
let qiyuFengdiSelecting = false;
let qiyuBaguanSelecting = false;
let qiyuBafangQianniuSelecting = false;
let qiyuZaizangSelecting = false;
let qiyuNilaiWangwangSelecting = false;
let qiyuNilaiWangwangCount = 0;
let qiyuNilaiWangwangFirstTarget = null;
let qiyuMeirenjiSelecting = false;
let qiyuMeirenjiFirstTarget = null;
let qiyuGuhuoSelecting = false;
let qiyuGanjinJuejueSelecting = false;
let qiyuHunanganshiSelecting = false;
let zangkuanSelectingTarget = false;
let qiyuLianyinSelectingProp = false;
let qiyuLianyinSelectingTarget = false;
let qiyuLianyinPropId = null;
let qiyuYinhuoDefuSelecting = false;
let selectingPinqianTarget = false;
let qiyuTargetId = null;
let nongminSelectedProps = [];
let nongminPropCount = 0;
let islandSwapBidsData = [];
let treasureClosePending = false;
let waitingHezongTarget = false;
let hezongPlayerIds = [];
let selectedChar = null, selectedVariant = null, selectedCharacters = {};
let hasJoined = false;
let isJailMap = false;
let chuanxiaoPinqianActive = false;
let fixedCwq = null;
let jailMinimized = false;
let jailDrag = { active: false, offsetX: 0, offsetY: 0 };
let awaitingGoToJail = false;
let dicePickerVisible = false;
let currentDiceValue = 0;
let wenjigifwuDiceValues = null;
let liebaoDiceValues = null;
let colorDiceSumValues = null;
let keepGArea = false;
let waitingForTurnEnd = false;
let hasClickedJudge = false;
let diceAnimating = false;
let diceAnimPlayerId = null;
let cicadaActive = false;
let cicadaCount = 0;
let cicadaPosition = null;
let cicadaAnimating = false;
let cicadaReady = false;
let cicadaCooldown = false;
let activePetUsedThisTurn = false;
let showThinkingOnce = false;
let gaituReformUsed = false;
let serverRestarting = false;

function resetDice() {
  dicePickerVisible = false;
  currentDiceValue = 0;
  wenjigifwuDiceValues = null;
  liebaoDiceValues = null;
  colorDiceSumValues = null;
  keepGArea = false;
  const overlay = document.getElementById('dicePickerOverlay');
  if (overlay) overlay.style.display = 'none';
  const cur = players[currentPlayerIdx];
  const isMyTurn = cur?.id === myId && !cur?.bankrupt;
  updateGAreaDiceImage(currentDiceValue, isMyTurn);
}

function doEndTurn() {
  document.getElementById('areaF').innerHTML = '';
  currentDiceValue = 0;
  wenjigifwuDiceValues = null;
  liebaoDiceValues = null;
  colorDiceSumValues = null;
  gaituReformUsed = false;
  selectingSwapTarget = false;
  selectingRouletteTarget = false;
  rouletteExcludedIds = [];
  selectingHezongTarget = false;
  waitingHezongTarget = false;
  hezongPlayerIds = [];
  selectingStartTarget = false;
  startTargetIds = [];
  const areaG = $('areaG');
  if (areaG) areaG.innerHTML = '';
  hasClickedJudge = false;
  selectingGuestTarget = false;
  selectingIslandSwapTarget = false;
  islandSwapBidsData = [];
  treasureClosePending = false;
  ['gaituPanel', 'guanyinPanel', 'gaituSwapPanel', 'gaituRoulettePanel', 'islandBidPanel', 'islandSwapResultsPanel', 'islandTreasurePanel'].forEach(id => {
    const el = $(id);
    if (el) el.remove();
  });
  document.querySelectorAll('.space.highlighted').forEach(el => {
    el.classList.remove('highlighted');
    el.style.cursor = '';
    el.onclick = null;
  });
  socket.emit('endTurn');
}

let mzSurnames = ['赵'];
let mzGivenNames = ['明'];

function coloredName(name, color) {
  return name;
}

// propertyData 数组格式说明：
// [地产名, [价格, 0房路费, 1房路费, 2房路费, 3房路费, 4房路费]]
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

// 地产名到图片文件名的映射
const propertyImageMap = {
  "广西": "guangxi",
  "江西": "jiangxi", 
  "新疆": "xinjiang",
  "青海": "qinghai",
  "西藏": "xizang",
  "宁夏": "ningxia",
  "云贵": "yungui",
  "内蒙": "neimeng",
  "澳门": "aomen",
  "浙江": "zhejiang",
  "江苏": "jiangsu",
  "四川": "sichuan",
  "香港": "xianggang",
  "台湾": "taiwan",
  "重庆": "chongqing",
  "五岳": "wuyue",
  "泰山": "wuyue",
  "华山": "wuyue",
  "衡山": "wuyue",
  "恒山": "wuyue",
  "嵩山": "wuyue",
  "广东": "guangdong",
  "机场": "jichang",
  "上海": "shanghai",
  "北京": "beijing",
  "长江": "changjiang",
  "黄河": "huanghe",
  "拼钱": "pinqian",
  "拍卖": "paimai",
  "拍卖卡": "paimaika",
  "四合院": "siheyuan",
  "昆仑": "kunlun",
  "宠物店": "chongwudian",
  "三思": "sansi",
  "改土": "gaitu",
  "断桥": "duanqiao",
  "土匪窝": "tufeiwo",
  "骰子屋": "daojuwu",
  "避难所": "binansuo",
  "观音庙": "guanyinmiao",
  "慈善屋": "cishanwu",
  "加油站": "jiayouzhan",
  "传送门": "chuansongmen",
  "货车场": "huochechang",
  "轮盘赌": "lunpandu",
  "合纵": "hezong",
  "钻石": "zuanshi",
  "机遇": "jiyu",
  "起点": "qidian",
  "财产罪": "caichanzui",
  "黄河": "huanghe"
};

const gaituImageNames = ['duanqiao', 'tufeiwo', 'daojuwu', 'binansuo', 'guanyinmiao', 'cishanwu', 'jiayouzhan', 'chuansongmen', 'huochechang', 'lunpandu'];

function getSpaceImageSrc(spaceName) {
  const imageName = propertyImageMap[spaceName] || spaceName.toLowerCase();
  if (gaituImageNames.includes(imageName)) return `/drawable/ditu/gaitu/${imageName}.png`;
  return `/drawable/ditu/${imageName}.png`;
}

// 格子特殊文字映射
const specialTextMap = {
  "起点": ["到达时选择工资+2/抽奇遇/+6/贷款"],
  "钻石": ["10回合后兑换20，工资+3；", "若运送者进监狱区域，钻石回到原地"],
  "江西": [],
  "拼钱": ["", "拼钱时输入的数字将会被扣除等量的钱，至少1，赢+10"],
  "台湾": ["", "地主到此令随机2人（可指定1人）进行德州扑克，输给赢10"],
  "香港": ["", "地主到此随机1人，可令其答题，两人依次承担答题结果"],
  "澳门": ["", "地主到此开盘：$0-20压大小，赚双倍"],
  "拍卖卡": ["", "拍卖两张随机卡片"],
  "五岳": ["", "可改造，下回合生效"],
  "泰山": ["后退3步"],
  "华山": ["地主到此收取每人随机1-6门票"],
  "衡山": ["休息1回合"],
  "恒山": ["地主到此获得免休卡"],
  "嵩山": ["地主到此判1-4生成骰子"],
  "宁夏": [],
  "内蒙": [],
  "四川": [],
  "重庆": [],
  "云贵": [],
  // 机遇、财产罪等非地产格子也可以有文字
  "机遇": ["抽1张机遇卡"],
  "财产罪": ["巨额财产来源不明，进监狱"],
  "四合院": ["集齐4色卡牌+15"],
  "宠物店": ["拍卖一项：宠物，自选卡，空地，自有资产"],
  "改土": ["改造$8，本回合/下回合生效"],
  "三思": ["你选1项，令他人从剩下的选1项"],
  "长江": ["+9/+9变黄河", "-10/-10变长江"],
  "黄河": ["-10/-10变长江", "+9/+9变黄河"],
  "新疆": ["", "丝绸之路：有人到达时，地主进/退1格"],
  "西藏": ["", "参悟：有人到达时，地主可令下回合掷大点/小点"],
  "青海": ["", "湖眼：有人到达时，地主可随机清除自身1个状态"],
  "合纵": ["连横：令合纵瓦解并给你7/令每人给你3；\n合纵：停留至少2回合直到两个合纵；两个合纵：选同一目标给你们每人7（不同失败），第一个合纵工资+3"],
  "机场": ["", "可改造，下回合生效"],
  "广西": ["", "选地与地主换此卡；地主到此选人换"],
  "昆仑": ["仙人赐福，每过几轮会为你提供一项强化"],
  "断桥": ["经过强停，到此处的掷2骰子，只有第1个判大点，第2个为有效点数"],
  "土匪窝": ["随机刷出2块地，令土匪前往其中1块并抢劫1次路费，然后此地停业"],
  "骰子屋": ["随机1个骰子，可令所有人-10并获得之"],
  "避难所": ["休息2回合且不能成为他人目标"],
  "观音庙": ["求签给香火钱有1/6概率净赚5倍"],
  "慈善屋": ["给每人4"],
  "加油站": ["再动一次"],
  "传送门": ["与人互换位置"],
  "货车场": ["放置大运车，下回合自动撞人"],
  "轮盘赌": ["选择目标进行俄罗斯轮盘赌，不能选择已经选过的目标，击中-24并进医院"]
};

const $ = id => document.getElementById(id);
const $j = id => document.getElementById(id) || { classList: { add: ()=>{}, remove: ()=>{} }, style: {}, innerHTML: '', setAttribute: ()=>{}, onclick: null };

function hideBoardArea() {
  const ba = $('hArea');
  if (ba) ba.style.display = 'none';
}
function showBoardArea() {
  const ba = $('hArea');
  if (ba) ba.style.display = '';
}
const startBtn = $('startBtn'), restartBtn2 = $('restartBtn2'), emojiBtn = $('emojiBtn'), testDiceBtn = $('testDiceBtn');
const buyBtn = $('buyBtn'), skipBtn = $('skipBtn');
const charBoxes = document.querySelectorAll('.char-box');
let expandedColor = null;

function refreshCharBoxes() {
  charBoxes.forEach(box => box.removeEventListener('click', handleCharClick));
  document.querySelectorAll('.char-box').forEach(box => box.addEventListener('click', handleCharClick));
}

function handleCharClick() {
  if (hasJoined || this.classList.contains('taken')) return;
  const char = this.dataset.char;
  const color = this.dataset.color;
  const expandRow = $('charExpandRow');

  if (expandRow && expandRow.contains(this)) {
    document.querySelectorAll('.char-expand-row .char-box').forEach(b => b.classList.remove('selected'));
    this.classList.add('selected');
    selectedChar = char;
    selectedVariant = char.replace(color, '');
    const mainBox = document.querySelector(`.char-main-grid .char-box[data-color="${color}"]`);
    if (mainBox) {
      mainBox.querySelector('img').src = `/drawable/juese/${char}.png`;
      mainBox.dataset.char = char;
    }
    triggerJoin();
    return;
  }

  if (expandedColor === color) {
    selectedChar = char;
    selectedVariant = char.replace(color, '');
    triggerJoin();
    return;
  }

  document.querySelectorAll('.char-box').forEach(b => b.classList.remove('selected'));
  this.classList.add('selected');
  selectedChar = char;
  selectedVariant = char.replace(color, '');

  expandRow.innerHTML = '';
  for (let i = 1; i <= 15; i++) {
    const vChar = color + i;
    const box = document.createElement('div');
    box.className = 'char-box';
    box.dataset.char = vChar;
    box.dataset.color = color;
    box.innerHTML = `<img src="/drawable/juese/${vChar}.png" alt="${color}${i}"><div class="select-ring"></div>`;
    expandRow.appendChild(box);
  }
  expandRow.classList.remove('hidden');
  expandedColor = color;
  refreshCharBoxes();
}

function triggerJoin() {
  const nameInput = $('playerNameInput');
  if (nameInput) {
    const surname = mzSurnames[Math.floor(Math.random() * mzSurnames.length)];
    const givenName = mzGivenNames[Math.floor(Math.random() * mzGivenNames.length)];
    nameInput.value = surname + givenName;
    nameInput.classList.remove('hidden');
  }
  joinGame();
}

charBoxes.forEach(box => box.addEventListener('click', handleCharClick));

socket.on('connect', () => {
  myId = socket.id;
  isDisconnected = false;
  const reconnectModal = document.getElementById('reconnectModal');
  if (reconnectModal) reconnectModal.remove();
  const disconnectBtn2 = $('disconnectBtn2');
  if (disconnectBtn2 && hasJoined) disconnectBtn2.classList.remove('hidden');
  // Auto-reconnect: if player was in a game, rejoin automatically
  // WebRTC 模式下（socket._real 已建立）不重复 auto-join，避免创建重复玩家
  const savedName = localStorage.getItem('monopoly_player_name');
  const savedCharFull = localStorage.getItem('monopoly_player_character');
  const savedVariant = localStorage.getItem('monopoly_player_variant');
  const wasJoined = localStorage.getItem('monopoly_has_joined') === 'true';

  if (!socket._real && savedName && savedCharFull) {
    // 解析character（可能包含variant）
    const colorMatch = savedCharFull.match(/^(hong|cheng|huang|haung|lv|lan|zi)(\d*)$/);
    let character = savedCharFull;
    let variant = savedVariant || '';

    if (colorMatch) {
      character = colorMatch[1] === 'haung' ? 'huang' : colorMatch[1];
      if (colorMatch[2] && !savedVariant) {
        variant = colorMatch[2];
      }
    }

    hasJoined = true;
    localStorage.setItem('monopoly_has_joined', 'true');
    socket.emit('join', { name: savedName, character: character, variant: variant });
    socket.emit('inLobby');
    $('gameContainer')?.classList.remove('hidden');
    $('actionBar')?.classList.remove('hidden');
    $('bottomBar')?.classList.remove('hidden');
  }
  render();
  refreshPlayerCards();
});

socket.on('connect_error', (err) => {
  console.error('❌ 连接失败:', err.message);
});

socket.on('disconnect', (reason) => {
  console.warn('⚠️ 断开连接:', reason);
  const disconnectBtn2 = $('disconnectBtn2');
  if (disconnectBtn2) disconnectBtn2.classList.add('hidden');
  if (serverRestarting || reason === 'io server disconnect') {
    setTimeout(() => {
      location.reload();
    }, 1000);
    return;
  }

  isDisconnected = true;
  // 断线后不再隐藏H区和S2区域，只隐藏底部区域（F区和G区）
  $('bottomBar')?.classList.add('hidden');
  $('areaE').innerHTML = '连接已断开，等待重连...';
  fitAreaEText();
  render();
  refreshPlayerCards();
});

socket.on('reconnect', () => {
  isDisconnected = false;
  const savedName = localStorage.getItem('monopoly_player_name');
  const savedCharFull = localStorage.getItem('monopoly_player_character');
  const savedVariant = localStorage.getItem('monopoly_player_variant');
  if (savedName && savedCharFull) {
    // 解析character（可能包含variant）
    const colorMatch = savedCharFull.match(/^(hong|cheng|huang|haung|lv|lan|zi)(\d*)$/);
    let character = savedCharFull;
    let variant = savedVariant || '';

    if (colorMatch) {
      character = colorMatch[1] === 'haung' ? 'huang' : colorMatch[1];
      // 如果localStorage存储的是合并格式（如"hong1"），则从character中提取variant
      if (colorMatch[2] && !savedVariant) {
        variant = colorMatch[2];
      }
    }

    socket.emit('join', { name: savedName, character: character, variant: variant });
    socket.emit('inLobby');
    $('gameContainer')?.classList.remove('hidden');
    $('actionBar')?.classList.remove('hidden');
    $('bottomBar')?.classList.remove('hidden');
  }
  render();
  refreshPlayerCards();
});

socket.on('reconnect_failed', () => {
  console.error('❌ 重连失败');
  isDisconnected = true;
  $('areaE').innerHTML = '连接已断开';
  fitAreaEText();
  render();
});

socket.on('mzNames', ({ surnames, givenNames }) => {
  mzSurnames = surnames;
  mzGivenNames = givenNames;
});

$('playerNameInput')?.addEventListener('input', () => {
  const nameInput = $('playerNameInput');
  if (!nameInput) return;
  let value = nameInput.value;
  let chineseCount = 0;
  let englishCount = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (/[^\x00-\xff]/.test(char)) {
      chineseCount++;
    } else {
      englishCount++;
    }
  }
  const totalLength = chineseCount + Math.ceil(englishCount / 2);
  if (chineseCount > 4 || englishCount > 8 || totalLength > 4) {
    let newValue = '';
    let newChinese = 0;
    let newEnglish = 0;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (/[^\x00-\xff]/.test(char)) {
        if (newChinese < 4) {
          newValue += char;
          newChinese++;
        }
      } else {
        if (newEnglish < 8) {
          newValue += char;
          newEnglish++;
        }
      }
    }
    nameInput.value = newValue;
  }
  if (hasJoined) {
    const newName = nameInput.value.trim();
    if (newName) {
      socket.emit('updateName', newName);
    }
  }
});

$('playerNameInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const nameInput = $('playerNameInput');
    if (nameInput) nameInput.classList.add('hidden');
  }
});

function joinGame() {
  if (!selectedChar || hasJoined) return;
  const nameInput = $('playerNameInput');
  let playerName = nameInput?.value.trim();
  if (!playerName) {
    const surname = mzSurnames[Math.floor(Math.random() * mzSurnames.length)];
    const givenName = mzGivenNames[Math.floor(Math.random() * mzGivenNames.length)];
    playerName = surname + givenName;
  }
  localStorage.setItem('monopoly_player_name', playerName);
  localStorage.setItem('monopoly_player_character', selectedChar);
  localStorage.setItem('monopoly_player_variant', selectedVariant);
  localStorage.setItem('monopoly_has_joined', 'true');
  socket.emit('join', { name: playerName, character: selectedChar, variant: selectedVariant });
  hasJoined = true;
  const disconnectBtn2 = $('disconnectBtn2');
  if (disconnectBtn2) disconnectBtn2.classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  const areaF = document.getElementById('areaF');
  const disconnectBtn2 = $('disconnectBtn2');
  if (disconnectBtn2) {
    disconnectBtn2.onclick = () => {
      socket.disconnect();
      isDisconnected = true;
      $('gameContainer')?.classList.add('hidden');
      $('actionBar')?.classList.add('hidden');
      $('bottomBar')?.classList.add('hidden');
      render();
      refreshPlayerCards();
    };
  }
});

socket.on('buildChoice', ({ spaceName, buildCost, houseLevel }) => {
  const me = players.find(p => p.id === myId);
  const hasJianfang = me && me.cards && me.cards.some(c => c.name === '建房卡');
  setAreaEText(`是否花$${buildCost}建房？`);
  let btns = '';
  if (hasJianfang) {
    btns += `<button id="jianfangBtn" class="jail-btn">建房卡</button>`;
  }
  btns += `<button id="buildBtn" class="jail-btn">建房</button>`;
  btns += `<button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('areaF').innerHTML = btns;
  const jianfangBtn = $('jianfangBtn');
  if (jianfangBtn) {
    jianfangBtn.onclick = () => {
      socket.emit('useJianfang');
      jianfangBtn.remove();
      const buildBtn = $('buildBtn');
      if (buildBtn) buildBtn.remove();
    };
  }
  const buildBtn = $('buildBtn');
  const endTurnBtn = $('endTurnBtn');
  if (buildBtn) {
    buildBtn.onclick = () => {
      socket.emit('buildHouse', 'build');
      buildBtn.remove();
      const jianfangBtn = $('jianfangBtn');
      if (jianfangBtn) jianfangBtn.remove();
    };
  }
  if (endTurnBtn) {
    endTurnBtn.onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      doEndTurn();
    };
  }
});

socket.on('taiwanChoice', ({ spaceName, houseLevel, buildCost }) => {
  if (houseLevel < 4) {
    $('areaE').textContent = `是否花$${buildCost}建房？是否令人德州扑克？`;
    let btns = `<button id="taiwanBuildBtn" class="jail-btn">建房</button>`;
    btns += `<button id="randomTwoBtn" class="jail-btn">随机2人</button>`;
    btns += `<button id="selectOneBtn" class="jail-btn">指定1人</button>`;
    btns += `<button id="taiwanEndTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('areaF').innerHTML = btns;
    $('taiwanBuildBtn').onclick = () => {
      socket.emit('taiwanBuild');
      $('taiwanBuildBtn').remove();
    };
    $('randomTwoBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('texasRandomTwo');
    };
    $('selectOneBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      $('areaE').textContent = '点击角色信息区指定一人';
      selectingTexasPlayer = true;
      refreshPlayerCards();
    };
    $('taiwanEndTurnBtn').onclick = () => { if (!$('taiwanEndTurnBtn').disabled) doEndTurn(); };
  } else {
    $('areaE').textContent = `${spaceName}已经满级，是否令人德州扑克？`;
    let btns = `<button id="randomTwoBtn" class="jail-btn">随机2人</button>`;
    btns += `<button id="selectOneBtn" class="jail-btn">指定1人</button>`;
    btns += `<button id="taiwanEndTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('areaF').innerHTML = btns;
    $('randomTwoBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('texasRandomTwo');
    };
    $('selectOneBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      $('areaE').textContent = '点击角色信息区指定一人';
      selectingTexasPlayer = true;
      refreshPlayerCards();
    };
    $('taiwanEndTurnBtn').onclick = () => { if (!$('taiwanEndTurnBtn').disabled) doEndTurn(); };
  }
});

socket.on('taiwanAfterBuild', ({ spaceName, houseLevel }) => {
  $('areaE').textContent = `${spaceName}升级！`;
});

socket.on('taiwanPokerChoice', () => {
  $('areaE').textContent = '是否德州扑克？';
  showPokerChoice();
});

let hongkongData = null;

socket.on('hongkongChoice', ({ spaceName, houseLevel, buildCost, ownerId, ownerName, ownerColor, randomPlayerName, randomPlayerColor, randomPlayerId }) => {
  hongkongData = { ownerId, ownerName, ownerColor, randomPlayerName, randomPlayerColor, randomPlayerId };
  if (houseLevel < 4) {
    $('areaE').innerHTML = `是否花${buildCost}建房？是否令${coloredName(randomPlayerName, randomPlayerColor)}答题？`;
    let btns = `<button id="hkBuildBtn" class="jail-btn">建房</button>`;
    btns += `<button id="hkQuizBtn" class="jail-btn">答题</button>`;
    btns += `<button id="hkEndTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('areaF').innerHTML = btns;
    $('hkBuildBtn').onclick = () => {
      socket.emit('hongkongBuild', { randomPlayerId });
      $('hkBuildBtn').remove();
    };
    $('hkQuizBtn').onclick = () => {
      socket.emit('hongkongStartQuiz', { ownerId, randomPlayerId });
      $('hkQuizBtn').remove();
      document.getElementById('areaF').style.display = 'none';
      $('hkEndTurnBtn').disabled = true;
    };
    $('hkEndTurnBtn').onclick = () => { if (!$('hkEndTurnBtn').disabled) doEndTurn(); };
  } else {
    $('areaE').innerHTML = `${spaceName}已经满级，是否令${coloredName(randomPlayerName, randomPlayerColor)}答题？`;
    let btns = `<button id="hkQuizBtn" class="jail-btn">答题</button>`;
    btns += `<button id="hkEndTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('areaF').innerHTML = btns;
    $('hkQuizBtn').onclick = () => {
      socket.emit('hongkongStartQuiz', { ownerId, randomPlayerId });
      $('hkQuizBtn').remove();
      document.getElementById('areaF').style.display = 'none';
      $('hkEndTurnBtn').disabled = true;
    };
    $('hkEndTurnBtn').onclick = () => { if (!$('hkEndTurnBtn').disabled) doEndTurn(); };
  }
});

socket.on('hongkongAfterBuild', ({ spaceName, houseLevel, ownerId, ownerName, ownerColor, randomPlayerName, randomPlayerColor, randomPlayerId, isOwner }) => {
  $('areaE').innerHTML = `${coloredName(ownerName, ownerColor)}的${spaceName}升级！`;
});

socket.on('hongkongAfterSkip', ({ ownerId, ownerName, ownerColor, randomPlayerName, randomPlayerColor, randomPlayerId, isOwner }) => {
  $('areaE').innerHTML = `${coloredName(ownerName, ownerColor)}放弃升级`;
});

socket.on('hongkongQuizEnd', ({ message, ownerId, randomPlayerId, isZhilijiemu }) => {
  const areaE = $('areaE');
  if (areaE) areaE.innerHTML = message;
  document.getElementById('areaF').style.display = '';
  const endTurnBtn = $('hkEndTurnBtn');
  if (endTurnBtn) endTurnBtn.disabled = false;
  if (isZhilijiemu) {
    socket.emit('zhilijiemuEnd');
  }
});

socket.on('hongkongSkipQuizResult', ({ message, ownerId }) => {
    $('areaE').innerHTML = message;
  document.getElementById('areaF').style.display = '';
  const endTurnBtn = $('hkEndTurnBtn');
  if (endTurnBtn) endTurnBtn.disabled = false;
});

function showHongkongQuizChoice(ownerId, ownerName, ownerColor, randomPlayerName, randomPlayerColor, randomPlayerId) {
  if (ownerId === myId) {
    let btns = `<button id="hkQuizBtn" class="jail-btn">答题</button>`;
    btns += `<button id="hkSkipQuizBtn" class="jail-btn">放弃</button>`;
    document.getElementById('areaF').innerHTML = btns;
    $('hkQuizBtn').onclick = () => {
      socket.emit('hongkongStartQuiz', { ownerId, randomPlayerId });
      document.getElementById('areaF').innerHTML = '';
    };
    $('hkSkipQuizBtn').onclick = () => {
      socket.emit('hongkongSkipQuiz', { ownerId, randomPlayerId });
      document.getElementById('areaF').innerHTML = '';
    };
  }
}

let macauData = null;
let macauGameState = null;

socket.on('macauChoice', ({ spaceName, houseLevel, buildCost, ownerId, ownerName, ownerColor }) => {
  macauData = { ownerId, ownerName, ownerColor };
  if (houseLevel < 4) {
    $('areaE').textContent = `是否花$${buildCost}建房？`;
    let btns = `<button id="macauBuildBtn" class="jail-btn">建房</button>`;
    btns += `<button id="macauGameBtn" class="jail-btn">开盘</button>`;
    btns += `<button id="macauEndTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('areaF').innerHTML = btns;
    $('macauBuildBtn').onclick = () => {
      socket.emit('macauBuild');
      $('macauBuildBtn').remove();
    };
    $('macauGameBtn').onclick = () => {
      socket.emit('macauStartGame');
      $('macauGameBtn').remove();
      $('macauEndTurnBtn').disabled = true;
    };
    $('macauEndTurnBtn').onclick = () => { if (!$('macauEndTurnBtn').disabled) doEndTurn(); };
  } else {
    $('areaE').textContent = `${spaceName}已经满级`;
    let btns = `<button id="macauGameBtn" class="jail-btn">开盘</button>`;
    btns += `<button id="macauEndTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('areaF').innerHTML = btns;
    $('macauGameBtn').onclick = () => {
      socket.emit('macauStartGame');
      $('macauGameBtn').remove();
      $('macauEndTurnBtn').disabled = true;
    };
    $('macauEndTurnBtn').onclick = () => { if (!$('macauEndTurnBtn').disabled) doEndTurn(); };
  }
});

socket.on('macauAfterBuild', ({ spaceName, houseLevel, ownerName, ownerColor }) => {
  $('areaE').innerHTML = `${coloredName(ownerName, ownerColor)}的${spaceName}升级！`;
});

socket.on('macauAfterSkip', ({ ownerName, ownerColor }) => {
  $('areaE').innerHTML = `${coloredName(ownerName, ownerColor)}放弃升级`;
});

function showMacauGameChoice(ownerId, ownerName, ownerColor) {
  if (ownerId === myId) {
    let btns = `<button id="macauGameBtn" class="jail-btn">开盘</button>`;
    btns += `<button id="macauSkipGameBtn" class="jail-btn">放弃</button>`;
    document.getElementById('areaF').innerHTML = btns;
    $('macauGameBtn').onclick = () => {
      socket.emit('macauStartGame');
      document.getElementById('areaF').innerHTML = '';
    };
    $('macauSkipGameBtn').onclick = () => {
      socket.emit('macauSkipGame');
      document.getElementById('areaF').innerHTML = '';
    };
  }
}

socket.on('macauGameStart', ({ ownerId, ownerName, ownerColor, players }) => {
  macauGameState = {
    ownerId,
    ownerName,
    ownerColor,
    players,
    myBet: 0,
    myChoice: null,
    myConfirmed: false,
    allConfirmed: false,
    result: null
  };
  $('areaE').textContent = '押大小，赚双倍';
  document.getElementById('areaF').innerHTML = '';
  createMacauPanel();
});

socket.on('macauPlayerUpdate', ({ playerId, bet, choice, confirmed }) => {
  if (!macauGameState) return;
  if (playerId === myId) {
    if (bet !== undefined) macauGameState.myBet = bet;
    if (choice !== undefined) macauGameState.myChoice = choice;
    if (confirmed !== undefined) macauGameState.myConfirmed = confirmed;
  }
  if (macauGameState.players[playerId]) {
    if (bet !== undefined) macauGameState.players[playerId].bet = bet;
    if (choice !== undefined) macauGameState.players[playerId].choice = choice;
    if (confirmed !== undefined) macauGameState.players[playerId].confirmed = confirmed;
  }
});

socket.on('macauAllConfirmed', ({ allConfirmed }) => {
  if (!macauGameState) return;
  macauGameState.allConfirmed = allConfirmed;
});

socket.on('macauResult', ({ result, results }) => {
  if (!macauGameState) return;
  macauGameState.result = result;
  
  const panel = $('macauPanel');
  if (panel) {
    const tImg = panel.querySelector('#macauT');
    if (tImg) {
      tImg.src = `/drawable/touzi/t${result}.png`;
      tImg.style.opacity = '1';
    }
  }
  
  if (results.length > 0) {
    const resultText = result <= 3 ? '小' : '大';
    const playersText = results.map(r => `${r.name}${r.change}`).join(',');
    $('areaE').innerHTML = `<span style="color:#fff;font-weight:bold;">${resultText}，${playersText}</span>`;
  }
  
  if (myId === macauGameState.ownerId) {
    document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    const endTurnBtn = document.getElementById('endTurnBtn');
    if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
  }
  
  const row3 = panel?.querySelector('#macauRow3');
  if (row3) {
    row3.style.display = 'none';
  }
  const closeBtn = document.createElement('div');
  closeBtn.className = 'texas-close-btn';
  closeBtn.textContent = '×';
  closeBtn.onclick = () => {
    if (panel) panel.remove();
    macauGameState = null;
  };
  if (panel) panel.appendChild(closeBtn);
});

socket.on('macauGameEnd', () => {
  const panel = $('macauPanel');
  if (panel) panel.remove();
  macauGameState = null;
});

function createMacauPanel() {
  const hArea = $('hArea');
  if (!hArea) return;
  
  const panel = document.createElement('div');
  panel.id = 'macauPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:url(/drawable/ditu/kaipan/bj11.jpg) center/cover;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:15px;padding:20px;box-sizing:border-box;';
  
  panel.innerHTML = `
    <div id="macauRow1" style="display:flex;align-items:center;gap:20px;">
      <div id="macauBig" style="position:relative;width:80px;height:80px;cursor:pointer;">
        <img src="/drawable/ditu/kaipan/cm5.png" style="width:100%;height:100%;">
        <span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:24px;color:#fff;font-weight:bold;">大</span>
      </div>
      <div style="position:relative;width:80px;height:80px;">
        <img src="/drawable/ditu/kaipan/cm5.png" style="width:100%;height:100%;">
        <span id="macauBetNum" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:32px;color:#fff;font-weight:bold;">0</span>
      </div>
      <div id="macauSmall" style="position:relative;width:80px;height:80px;cursor:pointer;">
        <img src="/drawable/ditu/kaipan/cm5.png" style="width:100%;height:100%;">
        <span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:24px;color:#fff;font-weight:bold;">小</span>
      </div>
    </div>
    <div id="macauRow2" style="display:flex;justify-content:center;">
      <img id="macauT" src="" style="width:100px;height:100px;opacity:0;">
    </div>
    <div id="macauRow3" style="display:flex;gap:10px;">
      <div id="macauCm1" style="width:60px;height:60px;cursor:pointer;">
        <img src="/drawable/ditu/kaipan/cm1.png" style="width:100%;height:100%;">
      </div>
      <div id="macauCm2" style="width:60px;height:60px;cursor:pointer;">
        <img src="/drawable/ditu/kaipan/cm2.png" style="width:100%;height:100%;">
      </div>
      <div id="macauCm3" style="width:60px;height:60px;cursor:pointer;">
        <img src="/drawable/ditu/kaipan/cm3.png" style="width:100%;height:100%;">
      </div>
      <div id="macauCm4" style="width:60px;height:60px;cursor:pointer;">
        <img src="/drawable/ditu/kaipan/cm4.png" style="width:100%;height:100%;">
      </div>
    </div>
    <div id="macauRow4" style="display:flex;gap:10px;justify-content:center;"></div>
  `;
  
  hArea.style.position = 'relative';
  hArea.appendChild(panel);
  
  $('macauCm1').onclick = () => addMacauBet(1);
  $('macauCm2').onclick = () => addMacauBet(2);
  $('macauCm3').onclick = () => addMacauBet(5);
  $('macauCm4').onclick = () => addMacauBet(10);
  
  updateMacauFButtons();
  
  $('macauBig').onclick = () => selectMacauChoice('big');
  $('macauSmall').onclick = () => selectMacauChoice('small');
}

function updateMacauFButtons() {
  if (!macauGameState || macauGameState.myConfirmed) return;
  
  const row4 = $('macauRow4');
  if (!row4) return;
  row4.innerHTML = '';
  
  const confirmBtn = document.createElement('button');
  confirmBtn.id = 'macauConfirmBtn';
  confirmBtn.className = 'jail-btn';
  confirmBtn.textContent = '确定';
  confirmBtn.disabled = true;
  row4.appendChild(confirmBtn);
  
  const clearBtn = document.createElement('button');
  clearBtn.id = 'macauClearBtn';
  clearBtn.className = 'jail-btn';
  clearBtn.textContent = '清零';
  clearBtn.disabled = true;
  row4.appendChild(clearBtn);
  
  const giveUpBtn = document.createElement('button');
  giveUpBtn.id = 'macauGiveUpBtn';
  giveUpBtn.className = 'jail-btn';
  giveUpBtn.textContent = '放弃';
  row4.appendChild(giveUpBtn);
  
  clearBtn.onclick = () => {
    macauGameState.myBet = 0;
    socket.emit('macauBet', { bet: 0 });
    $('macauBetNum').textContent = '0';
    clearBtn.disabled = true;
  };
  
  confirmBtn.onclick = () => {
    macauGameState.myConfirmed = true;
    socket.emit('macauConfirm');
    row4.innerHTML = '';
    $('macauRow3').style.display = 'none';
  };
  
  giveUpBtn.onclick = () => {
    macauGameState.myConfirmed = true;
    macauGameState.myBet = 0;
    socket.emit('macauBet', { bet: 0 });
    socket.emit('macauConfirm');
    row4.innerHTML = '';
    const panel = $('macauPanel');
    if (panel) {
      const row1 = $('macauRow1');
      if (row1) row1.innerHTML = '';
      const row3 = $('macauRow3');
      if (row3) row3.innerHTML = '';
    }
  };
}

function addMacauBet(amount) {
  if (!macauGameState || macauGameState.myConfirmed) return;
  const newBet = Math.min(20, macauGameState.myBet + amount);
  macauGameState.myBet = newBet;
  socket.emit('macauBet', { bet: newBet });
  $('macauBetNum').textContent = newBet;
  const clearBtn = $('macauClearBtn');
  if (clearBtn) clearBtn.disabled = false;
}

function selectMacauChoice(choice) {
  if (!macauGameState || macauGameState.myConfirmed) return;
  macauGameState.myChoice = choice;
  socket.emit('macauChoice', { choice });
  
  const bigEl = $('macauBig');
  const smallEl = $('macauSmall');
  
  if (choice === 'big') {
    smallEl.style.display = 'none';
  } else {
    bigEl.style.display = 'none';
  }
  
  const confirmBtn = $('macauConfirmBtn');
  if (confirmBtn) confirmBtn.disabled = false;
}

const wuyueMountains = [
  { name: '泰山', desc: '后退3步' },
  { name: '华山', desc: '地主到此收取每人随机1-6门票' },
  { name: '衡山', desc: '休息1回合' },
  { name: '恒山', desc: '地主到此获得免休卡' },
  { name: '嵩山', desc: '地主到此判1-4生成骰子' }
];

const gaituTypes = [
  { name: '断桥', desc: '经过强停，到此处的掷2骰子，只有第1个判大点，第2个为有效点数', image: '/drawable/ditu/gaitu/duanqiao.png' },
  { name: '土匪窝', desc: '随机刷出2块地，令土匪前往其中1块并抢劫1次路费，然后此地停业', image: '/drawable/ditu/gaitu/tufeiwo.png' },
  { name: '骰子屋', desc: '随机1个骰子，可令所有人-10并获得之', image: '/drawable/ditu/gaitu/daojuwu.png' },
  { name: '避难所', desc: '休息2回合且不能成为他人目标', image: '/drawable/ditu/gaitu/binansuo.png' },
  { name: '观音庙', desc: '求签给香火钱有1/6概率净赚5倍', image: '/drawable/ditu/gaitu/guanyinmiao.png' },
  { name: '慈善屋', desc: '给每人4', image: '/drawable/ditu/gaitu/cishanwu.png' },
  { name: '加油站', desc: '再动一次', image: '/drawable/ditu/gaitu/jiayouzhan.png' },
  { name: '传送门', desc: '与人互换位置', image: '/drawable/ditu/gaitu/chuansongmen.png' },
  { name: '货车场', desc: '放置大运车，下回合自动撞人', image: '/drawable/ditu/gaitu/huochechang.png' },
  { name: '轮盘赌', desc: '选择目标进行俄罗斯轮盘赌，不能选择已经选过的目标，击中-24并进医院', image: '/drawable/ditu/gaitu/lunpandu.png' }
];

let wuyueState = null;

socket.on('wuyueChoice', ({ spaceName, houseLevel, buildCost, spaceId }) => {
  wuyueState = { spaceId, spaceName };
  const isReformed = ['泰山','嵩山','恒山','衡山','华山'].includes(spaceName);
  
  if (houseLevel < 4) {
    $('areaE').textContent = `是否花$${buildCost}建房？`;
    let btns = `<button id="wuyueBuildBtn" class="jail-btn">建房</button>`;
    btns += `<button id="wuyueReformBtn" class="jail-btn">改造</button>`;
    if (isReformed) {
      btns += `<button id="wuyueEffectBtn" class="jail-btn">${spaceName}</button>`;
    }
    btns += `<button id="wuyueEndTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('areaF').innerHTML = btns;
    $('wuyueBuildBtn').onclick = () => {
      socket.emit('wuyueBuild', spaceId);
      $('wuyueBuildBtn').remove();
    };
    $('wuyueReformBtn').onclick = () => {
      socket.emit('wuyueReform', spaceId);
      $('wuyueReformBtn').remove();
      const effectBtn = $('wuyueEffectBtn');
      if (effectBtn) effectBtn.remove();
      saveAndHideAreaF();
    };
    if (isReformed) {
      $('wuyueEffectBtn').onclick = () => {
        socket.emit('wuyueMountainEffect', spaceId);
        $('wuyueEffectBtn').remove();
      };
    }
    $('wuyueEndTurnBtn').onclick = () => doEndTurn();
  } else {
    $('areaE').textContent = `${spaceName}已经满级`;
    let btns = `<button id="wuyueReformBtn" class="jail-btn">改造</button>`;
    if (isReformed) {
      btns += `<button id="wuyueEffectBtn" class="jail-btn">${spaceName}</button>`;
    }
    btns += `<button id="wuyueEndTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('areaF').innerHTML = btns;
    $('wuyueReformBtn').onclick = () => {
      socket.emit('wuyueReform', spaceId);
      $('wuyueReformBtn').remove();
      const effectBtn = $('wuyueEffectBtn');
      if (effectBtn) effectBtn.remove();
      saveAndHideAreaF();
    };
    if (isReformed) {
      $('wuyueEffectBtn').onclick = () => {
        socket.emit('wuyueMountainEffect', spaceId);
        $('wuyueEffectBtn').remove();
      };
    }
    $('wuyueEndTurnBtn').onclick = () => doEndTurn();
  }
});

socket.on('wuyueAfterBuild', ({ spaceName, houseLevel }) => {
  $('areaE').innerHTML = `${spaceName}升级！`;
});

socket.on('wuyueReformPanel', ({ spaceId, spaceName }) => {
  showWuyueReformPanel(spaceId);
});

socket.on('wuyueReformDone', ({ mountainName, mountainDesc, spaceId }) => {
  closeWuyueReformPanel();
  document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
  $('endTurnBtn').onclick = () => doEndTurn();
  const endTurnBtn = $('wuyueEndTurnBtn');
  if (endTurnBtn) endTurnBtn.disabled = false;
});

socket.on('airportReformDone', ({ spaceId, airportType }) => {
  closeAirportReformPanel();
  document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
  $('endTurnBtn').onclick = () => doEndTurn();
  const reformBtn = $('airportReformBtn');
  if (reformBtn) reformBtn.remove();
});

socket.on('startChoice', () => {
  const boardArea = document.getElementById('hArea');
  if (!boardArea) return;

  const existing = document.getElementById('startPanel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'startPanel';
  panel.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background-image:url(/drawable/bj2.jpeg);background-size:100% 100%;background-position:center;padding:20px;border-radius:12px;z-index:1000;width:auto;min-width:280px;max-width:90vw;';

  const row1 = document.createElement('div');
  row1.style.cssText = 'display:flex;gap:12px;justify-content:center;margin-bottom:8px;';
  const btn1 = document.createElement('button');
  btn1.textContent = '+6';
  btn1.className = 'jail-btn';
  btn1.style.cssText = 'font-size:20px;padding:12px 20px;';
  btn1.onclick = () => {
    panel.remove();
    socket.emit('startTarget');
  };
  row1.appendChild(btn1);

  const btn2 = document.createElement('button');
  btn2.textContent = '工资+2';
  btn2.className = 'jail-btn';
  btn2.style.cssText = 'font-size:20px;padding:12px 20px;';
  btn2.onclick = () => {
    panel.remove();
    socket.emit('startSalary');
  };
  row1.appendChild(btn2);
  panel.appendChild(row1);

  const row2 = document.createElement('div');
  row2.style.cssText = 'display:flex;gap:12px;justify-content:center;';
  const btn3 = document.createElement('button');
  btn3.textContent = '抽奇遇';
  btn3.className = 'jail-btn';
  btn3.style.cssText = 'font-size:20px;padding:12px 20px;';
  btn3.onclick = () => {
    panel.remove();
    socket.emit('startQiyu');
  };
  row2.appendChild(btn3);

  const btn5 = document.createElement('button');
  btn5.textContent = '贷款';
  btn5.className = 'jail-btn';
  btn5.style.cssText = 'font-size:20px;padding:12px 20px;';
  btn5.onclick = () => {
    panel.innerHTML = '';
    const loanOpts = [
      { label: '贷款27，利息3，每10轮还款10（11%）', amount: 27, interest: 3, installment: 10 },
      { label: '贷款52，利息8，每10轮还款20（15%）', amount: 52, interest: 8, installment: 20 },
      { label: '贷款100，利息20，每10轮还款40（20%）', amount: 100, interest: 20, installment: 40 }
    ];
    loanOpts.forEach(opt => {
      const loanRow = document.createElement('div');
      loanRow.style.cssText = 'display:flex;gap:12px;justify-content:center;margin-bottom:8px;';
      const loanBtn = document.createElement('button');
      loanBtn.textContent = opt.label;
      loanBtn.className = 'jail-btn';
      loanBtn.style.cssText = 'font-size:20px;padding:12px 20px;';
      loanBtn.onclick = () => {
        panel.remove();
        socket.emit('startLoan', { amount: opt.amount, interest: opt.interest, installment: opt.installment });
      };
      loanRow.appendChild(loanBtn);
      panel.appendChild(loanRow);
    });
  };
  row2.appendChild(btn5);
  panel.appendChild(row2);

  boardArea.appendChild(panel);
});

socket.on('qiyuDrawAnimation', ({ qiyuId, qiyuName, qiyuDesc }) => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
  const areaE = document.getElementById('areaE');
  areaE.innerHTML = `${qiyuName}：${qiyuDesc}`;
  fitAreaEText();
  
  // 在H区上方显示小动图（20px，不覆盖下面的区域）
  const hArea = document.getElementById('hArea');
  if (hArea) {
    const gifOverlay = document.createElement('div');
    gifOverlay.id = 'qiyuGifOverlay';
    gifOverlay.style.cssText = `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:100;pointer-events:none;`;
    gifOverlay.innerHTML = `<video src="/drawable/jiyu/qiyu.mp4?t=${Date.now()}" autoplay muted playsinline style="width:100%;height:auto;object-fit:contain;"></video>`;
    hArea.style.position = 'relative';
    hArea.appendChild(gifOverlay);
    setTimeout(() => { gifOverlay.remove(); }, 2000);
  }
  
  socket.emit('qiyuTestSelect', { qiyuId });
});

// 机遇动图显示
socket.on('jiyuShowGif', () => {
  const hArea = document.getElementById('hArea');
  if (!hArea) return;
  const gifOverlay = document.createElement('div');
  gifOverlay.id = 'jiyuGifOverlay';
  gifOverlay.style.cssText = `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:100;pointer-events:none;`;
  gifOverlay.innerHTML = `<video src="/drawable/jiyu/jiyu.mp4?t=${Date.now()}" autoplay muted playsinline style="width:100%;height:auto;object-fit:contain;"></video>`;
  hArea.style.position = 'relative';
  hArea.appendChild(gifOverlay);
  setTimeout(() => { gifOverlay.remove(); }, 2000);
});

socket.on('jiyuCardShow', ({ name, desc, hasDuogongneng, hasKoi }) => {
  if (!hasDuogongneng && !hasKoi) {
    socket.emit('clearBottomBarOverlay');
    socket.emit('jiyuCardResponse', { action: 'use' });
    return;
  }
  const cards = [];
  if (hasKoi) cards.push({ text: '锦鲤', action: 'koi' });
  if (hasDuogongneng) cards.push({ text: '多功能卡', action: 'redraw' });
  let rowsHtml = '<div class="tck-multi-rows">';
  rowsHtml += `<div class="tck-text" style="margin-bottom:8px;">${name}：${desc.replace(/\\n/g, '').replace(/\n/g, '')}</div>`;
  cards.forEach((card) => {
    rowsHtml += `<div class="tck-multi-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;">
      <span class="tck-text" style="flex:1;">${card.text}</span>
      <button class="tck-option-btn jiyu-koi-btn" data-action="${card.action}">使用</button>
    </div>`;
  });
  rowsHtml += '<div style="text-align:right;padding:4px 0;"><button class="tck-option-btn danger jiyu-koi-skip-btn">不用</button></div></div>';
  const stip = showTck('', '', null);
  stip.onclick = null;
  const contentDiv = stip.querySelector('.tck-content');
  contentDiv.innerHTML = rowsHtml;
  stip.querySelectorAll('.jiyu-koi-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      socket.emit('jiyuCardResponse', { action: btn.dataset.action });
      socket.emit('clearBottomBarOverlay');
      dismissTck(parseInt(stip.dataset.msgId));
    };
  });
  stip.querySelector('.jiyu-koi-skip-btn').onclick = (e) => {
    e.stopPropagation();
    socket.emit('jiyuCardResponse', { action: 'use' });
    socket.emit('clearBottomBarOverlay');
    dismissTck(parseInt(stip.dataset.msgId));
  };
});

socket.on('qiyuTestChoice', ({ qiyus }) => {
  const areaF = document.getElementById('areaF');
  let html = '';
  qiyus.forEach((q, i) => {
    html += `<button class="jail-btn qiyu-test-btn" data-qiyu-id="${q.id}">${i + 1}</button>`;
  });
  areaF.innerHTML = html;
  document.querySelectorAll('.qiyu-test-btn').forEach(btn => {
    btn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('qiyuTestSelect', { qiyuId: parseInt(btn.dataset.qiyuId) });
    };
  });
});

socket.on('qiyuSelectTarget', ({ playerId, qiyuId }) => {
  if (socket.id === playerId) {
    selectingQiyuTarget = true;
    qiyuTargetId = qiyuId;
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('startSelectTarget', ({ targetIds }) => {
  selectingStartTarget = true;
  startTargetIds = targetIds;
  render();
  checkNoValidTarget();
});

socket.on('airportChoice', ({ spaceName, houseLevel, buildCost, airportType, spaceId }) => {
  airportState = { spaceId, spaceName };
  
  if (houseLevel < 4) {
    $('areaE').textContent = `是否花$${buildCost}建房？`;
    let btns = `<button id="airportBuildBtn" class="jail-btn">建房</button>`;
    btns += `<button id="airportReformBtn" class="jail-btn">改造</button>`;
    if (airportType) {
      btns += `<button id="airportEffectBtn" class="jail-btn">${airportType}</button>`;
    }
    btns += `<button id="airportEndTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('areaF').innerHTML = btns;
    $('airportBuildBtn').onclick = () => {
      socket.emit('airportBuild', spaceId);
      $('airportBuildBtn').remove();
    };
    $('airportReformBtn').onclick = () => {
      socket.emit('airportReform', spaceId);
      $('airportReformBtn').remove();
      const effectBtn = $('airportEffectBtn');
      if (effectBtn) effectBtn.remove();
      saveAndHideAreaF();
    };
    if (airportType) {
      $('airportEffectBtn').onclick = () => {
        socket.emit('airportEffect', spaceId);
        $('airportEffectBtn').remove();
        const buildBtn = $('airportBuildBtn');
        if (buildBtn) buildBtn.remove();
        const reformBtn = $('airportReformBtn');
        if (reformBtn) reformBtn.remove();
        // 所有机场类型判定前就生成结束按钮
        document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
        $('endTurnBtn').onclick = () => doEndTurn();
      };
    }
    $('airportEndTurnBtn').onclick = () => doEndTurn();
  } else {
    $('areaE').textContent = `已经满级`;
    let btns = `<button id="airportReformBtn" class="jail-btn">改造</button>`;
    if (airportType) {
      btns += `<button id="airportEffectBtn" class="jail-btn">${airportType}</button>`;
    }
    btns += `<button id="airportEndTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('areaF').innerHTML = btns;
    $('airportReformBtn').onclick = () => {
      socket.emit('airportReform', spaceId);
      $('airportReformBtn').remove();
      const effectBtn = $('airportEffectBtn');
      if (effectBtn) effectBtn.remove();
      saveAndHideAreaF();
    };
    if (airportType) {
      $('airportEffectBtn').onclick = () => {
        socket.emit('airportEffect', spaceId);
        $('airportEffectBtn').remove();
        const reformBtn = $('airportReformBtn');
        if (reformBtn) reformBtn.remove();
        // 所有机场类型判定前就生成结束按钮
        document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
        $('endTurnBtn').onclick = () => doEndTurn();
      };
    }
    $('airportEndTurnBtn').onclick = () => doEndTurn();
  }
});

socket.on('airportBuilt', ({ spaceId }) => {
  $('areaE').innerHTML = `机场升级！`;
});

socket.on('airportReformPanel', ({ spaceId, spaceName }) => {
  showAirportReformPanel(spaceId);
});

function showAirportReformPanel(spaceId) {
  const hArea = $('hArea');
  if (!hArea) return;
  
  const panel = document.createElement('div');
  panel.id = 'airportReformPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,1);z-index:100;display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:4px;padding:4px;box-sizing:border-box;overflow:hidden;';
  
  const planes = [
    { name: '轰炸机', desc: '地主到此获得炸弹卡' },
    { name: '度假机', desc: '判1-2飞往海南，3-4休息1回合' },
    { name: '观光机', desc: '随机弹飞' },
    { name: '客机', desc: '地主到此飞往任1格' },
    { name: '间谍机', desc: '地主到此掷后暗置并声明用某点数,他人可质疑：真,质疑者给你6;假反之。无人质疑：地主+9' }
  ];
  
  let rowsHtml = planes.map(m => 
    `<div class="airport-plane-row" data-plane="${m.name}" data-desc="${m.desc}" style="display:flex;align-items:center;gap:8px;padding:4px 8px;background:rgba(255,255,255,0.1);border-radius:6px;cursor:pointer;box-sizing:border-box;flex:1;min-height:0;">
      <span style="color:#FFD700;font-size:clamp(14px,3.5vw,22px);font-weight:bold;min-width:40px;white-space:nowrap;">${m.name}</span>
      <span style="color:#fff;font-size:clamp(12px,2.8vw,18px);line-height:1.3;overflow:hidden;text-overflow:ellipsis;">${m.desc}</span>
    </div>`
  ).join('');
  
  panel.innerHTML = rowsHtml;
  
  hArea.style.position = 'relative';
  hArea.appendChild(panel);
  
  panel.querySelectorAll('.airport-plane-row').forEach(row => {
    row.onclick = () => {
      const planeName = row.dataset.plane;
      const planeDesc = row.dataset.desc;
      socket.emit('airportReformSelect', { spaceId, airportType: planeName, airportDesc: planeDesc });
    };
  });
}

function closeAirportReformPanel() {
  const panel = document.getElementById('airportReformPanel');
  if (panel) panel.remove();
}

socket.on('airportGuestPanel', ({ spaceId, spaceName }) => {
  selectingGuestTarget = true;
  $('areaE').innerHTML = '请选择目的地';
  document.getElementById('areaF').innerHTML = '';
  renderBoardOnly();
  initBoardTileClick();
});

let savedAreaFContent = '';

function saveAndHideAreaF() {
  const areaF = document.getElementById('areaF');
  if (areaF) {
    savedAreaFContent = areaF.innerHTML;
    areaF.innerHTML = '';
  }
}

function restoreAreaF() {
  const areaF = document.getElementById('areaF');
  if (areaF && savedAreaFContent) {
    areaF.innerHTML = savedAreaFContent;
    savedAreaFContent = '';
    rebindAreaFButtons();
  }
}

function rebindAreaFButtons() {
  const endTurnBtn = document.getElementById('endTurnBtn');
  if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
  const wuyueBuildBtn = $('wuyueBuildBtn');
  if (wuyueBuildBtn) wuyueBuildBtn.onclick = () => { socket.emit('wuyueBuild', wuyueState?.spaceId); wuyueBuildBtn.remove(); };
  const wuyueReformBtn = $('wuyueReformBtn');
  if (wuyueReformBtn) wuyueReformBtn.onclick = () => { socket.emit('wuyueReform', wuyueState?.spaceId); wuyueReformBtn.remove(); saveAndHideAreaF(); };
  const wuyueEffectBtn = $('wuyueEffectBtn');
  if (wuyueEffectBtn) wuyueEffectBtn.onclick = () => { socket.emit('wuyueMountainEffect', wuyueState?.spaceId); wuyueEffectBtn.remove(); };
  const wuyueEndTurnBtn = $('wuyueEndTurnBtn');
  if (wuyueEndTurnBtn) wuyueEndTurnBtn.onclick = () => doEndTurn();
  const airportBuildBtn = $('airportBuildBtn');
  if (airportBuildBtn) airportBuildBtn.onclick = () => { socket.emit('airportBuild', airportState?.spaceId); airportBuildBtn.remove(); };
  const airportReformBtn = $('airportReformBtn');
  if (airportReformBtn) airportReformBtn.onclick = () => { socket.emit('airportReform', airportState?.spaceId); airportReformBtn.remove(); saveAndHideAreaF(); };
  const airportEffectBtn = $('airportEffectBtn');
  if (airportEffectBtn) airportEffectBtn.onclick = () => { socket.emit('airportEffect', airportState?.spaceId); airportEffectBtn.remove(); };
  const airportEndTurnBtn = $('airportEndTurnBtn');
  if (airportEndTurnBtn) airportEndTurnBtn.onclick = () => doEndTurn();
}

function selectAirportGuestTarget(spaceId, spaceName) {
  selectingGuestTarget = false;
  socket.emit('airportGuestSelect', { targetSpaceId: spaceId });
}

function initBoardTileClick() {
  document.querySelectorAll('.space').forEach(el => {
    if (selectingGuestTarget) {
      el.style.cursor = 'pointer';
      el.style.outline = '2px solid #fff'; el.style.outlineOffset = '-2px';
      el.onclick = (e) => {
        e.stopPropagation();
        document.querySelectorAll('.space').forEach(s => { s.style.outline = ''; s.style.cursor = ''; s.onclick = null; });
        const spaceId = parseInt(el.dataset.id);
        if (!isNaN(spaceId)) {
          selectAirportGuestTarget(spaceId, board[spaceId]?.name);
        }
      };
    }
  });
}

function closeAirportGuestPanel() {
  const panel = document.getElementById('airportGuestPanel');
  if (panel) panel.remove();
}

socket.on('airportSpyDeclaration', ({ secretNumber }) => {
  // 文字显示在E区（去掉换行符），选点数显示在F区
  const areaE = $('areaE');
  if (areaE) areaE.innerHTML = `掷的骰子点数为${secretNumber}，请声明一个点数作为你的骰子；他人可质疑：真，质疑者给你6；假，你给质疑者6；无人质疑：你+9`;
  
  const areaF = $('areaF');
  if (areaF) areaF.innerHTML = '';
  showDiceSelectInF(1, 6, (i) => {
    socket.emit('airportSpyDeclare', { declaredNumber: i });
    areaF.innerHTML = '';
  });
});

function declareAirportSpyNumber(declaredNumber) {
  socket.emit('airportSpyDeclare', { declaredNumber });
  const areaF = $('areaF');
  if (areaF) areaF.innerHTML = '';
}

function closeAirportSpyPanel() {
  // 不再需要面板，保留空函数以防报错
}

socket.on('airportSpyChallenge', ({ declaredNumber, challengerIds }) => {
  showAirportSpyChallengeButtons(declaredNumber);
});

function showAirportSpyChallengeButtons(declaredNumber) {
  const isMyTurn = currentPlayerIdx === players.findIndex(p => p.id === myId);
  if (isMyTurn) return;
  
  const areaF = $('areaF');
  if (!areaF) return;
  
  areaF.innerHTML = `
    <div style="text-align:center;padding:10px;">
      <button id="spyChallengeBtn" class="jail-btn">质疑</button>
      <button id="spyBelieveBtn" class="jail-btn">相信</button>
    </div>
  `;
  
  $('spyChallengeBtn').onclick = () => {
    socket.emit('airportSpyResponse', { response: 'challenge' });
    areaF.innerHTML = '';
  };
  $('spyBelieveBtn').onclick = () => {
    socket.emit('airportSpyResponse', { response: 'believe' });
    areaF.innerHTML = '';
  };
}

socket.on('restoreSpyF', () => {
  const areaF = $('areaF');
  if (areaF) areaF.innerHTML = '';
});

socket.on('closeSpyPanel', () => {
  closeAirportSpyPanel();
});

socket.on('spyResult', ({ secretNumber, declaredNumber, result, challengerNames, playerId }) => {
  const areaF = $('areaF');
  if (areaF) {
    if (myId === playerId) {
      // 当前玩家显示结束按钮
      areaF.innerHTML = `<button id="endTurnBtn" class="jail-btn">结束</button>`;
      document.getElementById('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('spyClose');
      };
    } else {
      // 其他玩家清空F区
      areaF.innerHTML = '';
    }
  }
});



socket.on('addCardToD', ({ cardImage, cardName }) => {
  // 刷新D区卡片显示
  console.log('DEBUG addCardToD received:', { cardImage, cardName });
  render(); // 刷新整个界面，包括D区卡片
});

function showWuyueReformPanel(spaceId) {
  const boardArea = $('hArea');
  if (!boardArea) return;

  const panel = document.createElement('div');
  panel.id = 'wuyueReformPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,1);z-index:100;display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:4px;padding:4px;box-sizing:border-box;overflow:hidden;';

  let rowsHtml = wuyueMountains.map(m => 
    `<div class="wuyue-mountain-row" data-mountain="${m.name}" data-desc="${m.desc}" style="display:flex;align-items:center;gap:8px;padding:4px 8px;background:rgba(255,255,255,0.1);border-radius:6px;cursor:pointer;box-sizing:border-box;flex:1;min-height:0;">
      <span style="color:#FFD700;font-size:clamp(14px,3.5vw,22px);font-weight:bold;min-width:40px;white-space:nowrap;">${m.name}</span>
      <span style="color:#fff;font-size:clamp(12px,2.8vw,18px);line-height:1.3;overflow:hidden;text-overflow:ellipsis;">${m.desc}</span>
    </div>`
  ).join('');

  panel.innerHTML = rowsHtml;

  boardArea.style.position = 'relative';
  boardArea.appendChild(panel);

  panel.querySelectorAll('.wuyue-mountain-row').forEach(row => {
    row.onclick = () => {
      const mountainName = row.dataset.mountain;
      const mountainDesc = row.dataset.desc;
      socket.emit('wuyueReformSelect', { spaceId, mountainName, mountainDesc });
    };
  });
}

function closeWuyueReformPanel() {
  const panel = $('wuyueReformPanel');
  if (panel) panel.remove();
}

let quizState = null;
let quizTimer = null;

let siheyuanState = null;
let airportState = null;

const suitNameMap = { hongtao: '♥', meihua: '♣', fangkuai: '♦', heitao: '♠' };

socket.on('siheyuanStart', ({ row2Suits, row3Suits, isTianhu, playerName, playerColor, missingSuits }) => {
  siheyuanState = { row2Suits, row3Suits, revealed: [false, false, false, false], isTianhu, playerName, playerColor, missingSuits };
  if (isTianhu) {
    showSiheyuanPanel(row2Suits, row3Suits, true);
  } else {
    showSiheyuanPanel(row2Suits, row3Suits, false);
  }
  document.getElementById('areaF').innerHTML = '';
});

socket.on('siheyuanResult', ({ cardIndex, suit, allCollected, allRevealed, missingSuits, playerName, playerColor }) => {
  if (!siheyuanState) return;
  siheyuanState.revealed[cardIndex] = true;
  siheyuanState.missingSuits = missingSuits;

  const panel = $('siheyuanPanel');
  if (panel) {
    const cardEl = panel.querySelector(`[data-row3="${cardIndex}"]`);
    if (cardEl) {
      const kabei = cardEl.querySelector('.shy-kabei');
      if (kabei) kabei.remove();
      cardEl.onclick = null;
      cardEl.style.cursor = 'default';
    }
    if (!window.shyFpEnded) {
      const canvas = document.getElementById('shyFpCanvas');
      if (canvas) canvas.style.display = 'none';
      const container = document.getElementById('shyFpContainer');
      const video = document.getElementById('shyFpGif');
      if (video) {
        video.style.display = '';
        video.currentTime = 0;
        video.play().catch(() => {});
        video.onended = () => { video.style.display = 'none'; };
      }
    }
  }

  if (allCollected || allRevealed) {
    window.shyFpEnded = true;
  }
});

socket.on('siheyuanClose', () => {
  closeSiheyuanPanel();
  const cur = players[currentPlayerIdx];
  if (cur?.id === myId) {
    document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    $('endTurnBtn').onclick = () => doEndTurn();
  } else {
    if (!treasureClosePending) {
      document.getElementById('areaF').innerHTML = '';
    }
  }
});

socket.on('siheyuanGiveUpResult', ({ playerName, playerColor }) => {
  document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
  $('endTurnBtn').onclick = () => doEndTurn();
});

socket.on('siheyuanWatch', ({ row2Suits, row3Suits, revealed, playerName, playerColor, playerId }) => {
  if (myId === playerId) return;
  showSiheyuanWatchPanel(row2Suits, row3Suits, revealed);
});

socket.on('siheyuanWatchUpdate', ({ cardIndex, suit, revealed, allCollected, playerName, playerColor }) => {
  const panel = $('siheyuanPanel');
  console.log('[SHY-UPDATE] cardIndex:', cardIndex, 'suit:', suit, 'allCollected:', allCollected, 'shyFpEnded:', window.shyFpEnded, 'panel:', !!panel);
  if (panel) {
    const cardEl = panel.querySelector(`[data-row3="${cardIndex}"]`);
    if (cardEl) {
      const kabei = cardEl.querySelector('.shy-kabei');
      if (kabei) kabei.remove();
    }
    if (!window.shyFpEnded) {
      // 观看面板不播视频（iOS 非手势无法播放），保留占位图
      console.log('[SHY-UPDATE] watch reveal, placeholder stays');
    }
    if (allCollected) {
      window.shyFpEnded = true;
    }
  }
});

socket.on('siheyuanWatchGiveUp', ({ playerName, playerColor }) => {
  closeSiheyuanPanel();
});

// 在视频容器中创建占位图片
function _shyCreatePlaceholderImg(container) {
  const img = document.createElement('img');
  img.id = 'shyPlaceholder';
  img.src = '/drawable/ditu/siheyuan/fapai.png?' + Date.now();
  img.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:6px;';
  container.appendChild(img);
  return img;
}

// 动态创建视频并播放（必须在用户手势中调用）
function _shyPlayVideo(container, onEnded) {
  // 移除占位图
  const placeholder = document.getElementById('shyPlaceholder');
  if (placeholder) placeholder.style.display = 'none';
  // 移除已有视频
  const old = document.getElementById('shyFpGif');
  if (old) old.remove();
  const video = document.createElement('video');
  video.id = 'shyFpGif';
  video.src = '/drawable/ditu/siheyuan/fp.mp4?' + Date.now();
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:6px;';
  container.appendChild(video);
  video.currentTime = 0;
  video.play().then(() => {
    console.log('[SHY] video play() succeeded');
  }).catch((err) => {
    console.log('[SHY] video play() failed:', err.message, err.code, err.name);
  });
  video.onended = () => {
    console.log('[SHY] video ended');
    video.remove();
    if (placeholder) placeholder.style.display = '';
    if (onEnded) onEnded();
  };
}

function showSiheyuanPanel(row2Suits, row3Suits, isTianhu) {
  const boardArea = $('hArea');
  if (!boardArea) return;
  window.shyFpEnded = false;

  const panel = document.createElement('div');
  panel.id = 'siheyuanPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;width:100%;height:100%;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;box-sizing:border-box;';

  const row2Html = row2Suits.map(s => `<img src="/drawable/ditu/siheyuan/${s}.png" style="width:60px;height:85px;border-radius:6px;">`).join('');
  const row3Html = row3Suits.map((s, i) => {
    if (isTianhu) {
      return `<div data-row3="${i}" style="position:relative;width:60px;height:85px;cursor:default;"><img src="/drawable/ditu/siheyuan/${s}.png" style="width:100%;height:100%;border-radius:6px;"></div>`;
    }
    return `<div data-row3="${i}" style="position:relative;width:60px;height:85px;cursor:pointer;"><img src="/drawable/ditu/siheyuan/${s}.png" style="width:100%;height:100%;border-radius:6px;"><img class="shy-kabei" src="/drawable/ditu/siheyuan/kabei.png" style="position:absolute;top:0;left:0;width:100%;height:100%;border-radius:6px;"></div>`;
  }).join('');

  panel.innerHTML = `
    <div id="shyCardsArea" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:0;">
      <div style="display:flex;gap:8px;justify-content:center;">${row2Html}</div>
      <div style="display:flex;gap:8px;justify-content:center;">${row3Html}</div>
    </div>
    <div id="shyFpContainer" style="flex:0 0 auto;display:flex;align-items:center;justify-content:center;height:200px;max-height:35%;">
    </div>
  `;

  const closeBtn = document.createElement('div');
  closeBtn.className = 'texas-close-btn';
  closeBtn.textContent = '×';
  closeBtn.onclick = () => {
    closeSiheyuanPanel();
    document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    $('endTurnBtn').onclick = () => doEndTurn();
    socket.emit('siheyuanCloseFromClient');
  };
  panel.appendChild(closeBtn);

  boardArea.style.position = 'relative';
  boardArea.appendChild(panel);

  // 用 <img> 代替 CSS background（iOS 渲染更可靠）
  const bgImg = document.createElement('img');
  bgImg.src = '/drawable/ditu/siheyuan/pkq.png?' + Date.now();
  bgImg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:fill;z-index:-1;pointer-events:none;';
  bgImg.onload = () => console.log('[SHY] bg img loaded');
  bgImg.onerror = () => console.log('[SHY] bg img load failed');
  panel.insertBefore(bgImg, panel.firstChild);

  // 显示占位图（代替隐藏的视频）
  const container = document.getElementById('shyFpContainer');
  console.log('[SHY] panel created, container:', !!container, 'boardArea offsetHeight:', boardArea.offsetHeight, 'offsetWidth:', boardArea.offsetWidth);
  if (container) {
    _shyCreatePlaceholderImg(container);
  }

  if (!isTianhu) {
    panel.querySelectorAll('[data-row3]').forEach(el => {
      el.onclick = () => {
        const idx = parseInt(el.dataset.row3);
        const kabei = el.querySelector('.shy-kabei');
        if (!kabei) return;
        // 在用户手势中动态创建视频并播放
        const fc = document.getElementById('shyFpContainer');
        if (fc) _shyPlayVideo(fc);
        console.log('[SHY] card click idx:', idx);
        socket.emit('siheyuanReveal', idx);
      };
    });
  }
}

function showSiheyuanWatchPanel(row2Suits, row3Suits, revealed) {
  const boardArea = $('hArea');
  if (!boardArea) return;
  window.shyFpEnded = false;

  const panel = document.createElement('div');
  panel.id = 'siheyuanPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;width:100%;height:100%;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;box-sizing:border-box;';

  const row2Html = row2Suits.map(s => `<img src="/drawable/ditu/siheyuan/${s}.png" style="width:60px;height:85px;border-radius:6px;">`).join('');
  const row3Html = row3Suits.map((s, i) => {
    if (revealed[i]) {
      return `<div data-row3="${i}" style="position:relative;width:60px;height:85px;cursor:default;"><img src="/drawable/ditu/siheyuan/${s}.png" style="width:100%;height:100%;border-radius:6px;"></div>`;
    }
    return `<div data-row3="${i}" style="position:relative;width:60px;height:85px;cursor:default;"><img src="/drawable/ditu/siheyuan/${s}.png" style="width:100%;height:100%;border-radius:6px;"><img class="shy-kabei" src="/drawable/ditu/siheyuan/kabei.png" style="position:absolute;top:0;left:0;width:100%;height:100%;border-radius:6px;"></div>`;
  }).join('');

  panel.innerHTML = `
    <div id="shyCardsArea" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:0;">
      <div style="display:flex;gap:8px;justify-content:center;">${row2Html}</div>
      <div style="display:flex;gap:8px;justify-content:center;">${row3Html}</div>
    </div>
    <div id="shyFpContainer" style="flex:0 0 auto;display:flex;align-items:center;justify-content:center;height:200px;max-height:35%;">
    </div>
  `;

  boardArea.style.position = 'relative';
  boardArea.appendChild(panel);
  console.log('[SHY-WATCH] panel created, offsetHeight:', boardArea.offsetHeight, 'offsetWidth:', boardArea.offsetWidth);

  // 用 <img> 代替 CSS background（iOS 渲染更可靠）
  const bgImg = document.createElement('img');
  bgImg.src = '/drawable/ditu/siheyuan/pkq.png?' + Date.now();
  bgImg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:fill;z-index:-1;pointer-events:none;';
  bgImg.onload = () => console.log('[SHY-WATCH] bg img loaded');
  bgImg.onerror = () => console.log('[SHY-WATCH] bg img load failed');
  panel.insertBefore(bgImg, panel.firstChild);

  // 显示占位图（代替隐藏的视频）
  const container = document.getElementById('shyFpContainer');
  console.log('[SHY-WATCH] container found:', !!container);
  if (container) {
    _shyCreatePlaceholderImg(container);
  }
}

function closeSiheyuanPanel() {
  const panel = $('siheyuanPanel');
  if (panel) panel.remove();
  siheyuanState = null;
}

socket.on('hongkongStartQuiz', ({ ownerId, ownerName, ownerColor, randomPlayerName, randomPlayerColor, randomPlayerId, isZhilijiemu }) => {
  quizState = {
    ownerId,
    ownerName,
    ownerColor,
    randomPlayerName,
    randomPlayerColor,
    randomPlayerId,
    correctCount: 0,
    currentQuestion: 0,
    isStarted: false,
    isZhilijiemu: isZhilijiemu || false
  };
  
  $('areaE').innerHTML = `${coloredName(randomPlayerName, randomPlayerColor)}正在答题…`;
  showQuizPanel();
});

function showQuizPanel() {
  const boardEl = $('board');
  if (!boardEl) return;
  
  let panel = document.getElementById('quizPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'quizPanel';
    boardEl.parentElement.style.position = 'relative';
    boardEl.parentElement.appendChild(panel);
  }
  
  const isQuizPlayer = myId === quizState.randomPlayerId;
  
  panel.innerHTML = `
    <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: url('/drawable/bj10.png') center/cover; z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2vh 2vw; box-sizing: border-box; overflow: hidden; gap: 0;">
      <div id="quizHeader" style="flex: 0 0 auto; font-size: clamp(12px,3.5vh,36px); color: #fff; text-align: center; display: flex; align-items: center; justify-content: center; gap: 2vw;">
        <span>20题答完+40</span>
      </div>
      <div id="quizTimeline" style="flex: 0 0 auto; width: 80%; height: max(4px, 1vh); border-radius: 6px; overflow: hidden; margin: 0.5vh 0;">
        <div id="quizTimelineBar" style="width: 100%; height: 100%; background-color: #e74c3c;"></div>
      </div>
      ${isQuizPlayer ? '<button id="quizStartBtn" style="flex: 0 0 auto; font-size: clamp(12px,3.5vh,36px); color: #000; background: #fff; border: none; border-radius: 6px; padding: 0.5vh 3vw; cursor: pointer; margin: 0.5vh 0;">开始</button>' : ''}
      <div id="quizGrid" style="flex: 1 1 auto; display: grid; grid-template-columns: repeat(10, 1fr); grid-template-rows: repeat(2, 1fr); gap: clamp(1px,0.3vh,4px); width: 80%; min-height: 0; max-height: 40%;">
        ${Array(20).fill(0).map(() => '<div class="quiz-grid-cell" style="background: transparent; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: clamp(6px,1.5vh,16px); color: #fff;"></div>').join('')}
      </div>
      <div id="quizAnswers" style="flex: 0 0 auto; display: flex; gap: clamp(2px,1vw,10px); justify-content: center; margin-top: 0.5vh;">
        ${Array(5).fill(0).map((_, i) => `<button class="quiz-answer-btn" data-index="${i}" style="flex: 1; max-width: 18%; aspect-ratio: 1; font-size: clamp(8px,2.5vh,32px); background: transparent; color: transparent; border: 2px solid rgba(255,255,255,0.3); border-radius: 6px;" ${!isQuizPlayer ? 'disabled' : ''}></button>`).join('')}
      </div>
    </div>
  `;
  
  if (isQuizPlayer) {
    $('quizStartBtn').onclick = () => {
      $('quizStartBtn').remove();
      startQuizGame();
    };
  }
}

function startQuizGame() {
  if (!quizState) return;
  quizState.isStarted = true;
  quizState.currentQuestion = 0;
  quizState.correctCount = 0;
  
  const questionData = generateQuestionData();
  socket.emit('quizStartGame', { 
    questionText: questionData.questionText, 
    answers: questionData.answers,
    correctAnswer: questionData.correctAnswer
  });
  showQuestion(questionData.questionText, questionData.answers);
  startTimeline();
}

function generateQuestionData() {
  const isAdd = Math.random() > 0.5;
  let a, b, c;
  
  if (isAdd) {
    a = Math.floor(Math.random() * 19) + 1;
    b = Math.floor(Math.random() * (20 - a)) + 1;
    c = a + b;
  } else {
    a = Math.floor(Math.random() * 19) + 2;
    b = Math.floor(Math.random() * (a - 1)) + 1;
    c = a - b;
  }
  
  const questionText = `${a}${isAdd ? '+' : '-'}${b}=?`;
  const answers = [c];
  while (answers.length < 5) {
    const rand = Math.floor(Math.random() * 20) + 1;
    if (!answers.includes(rand) && rand !== 0) answers.push(rand);
  }
  for (let i = answers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [answers[i], answers[j]] = [answers[j], answers[i]];
  }
  
  return { questionText, answers, correctAnswer: c };
}

function showQuestion(questionText, answers) {
  const header = $('quizHeader');
  if (header) {
    header.innerHTML = `<span>${questionText}</span>`;
  }
  
  const answerBtns = document.querySelectorAll('.quiz-answer-btn');
  answerBtns.forEach((btn, i) => {
    btn.textContent = answers[i];
    btn.style.color = '#fff';
    btn.style.background = 'transparent';
    btn.style.border = '2px solid transparent';
    btn.disabled = myId !== quizState?.randomPlayerId;
    if (btn.disabled) {
      btn.style.background = 'transparent';
      btn.style.color = '#fff';
    }
    btn.onclick = () => checkAnswer(answers[i], btn);
  });
}

socket.on('quizStartGame', ({ questionText, answers, correctAnswer }) => {
  if (quizState) {
    quizState.isStarted = true;
    quizState.currentQuestionText = questionText;
    quizState.correctAnswer = correctAnswer;
    quizState.answers = answers;
    quizState.currentQuestion = 0;
    quizState.correctCount = 0;
    showQuestion(questionText, answers);
    const bar = $('quizTimelineBar');
    if (bar) {
      bar.style.width = '100%';
      bar.style.backgroundColor = '#e74c3c';
    }
    startTimeline();
  }
});

function generateQuestion() {
  if (!quizState || quizState.currentQuestion >= 20) return;
  
  const questionData = generateQuestionData();
  quizState.currentQuestionText = questionData.questionText;
  quizState.correctAnswer = questionData.correctAnswer;
  quizState.answers = questionData.answers;
  
  showQuestion(questionData.questionText, questionData.answers);
}

function startTimeline() {
  const bar = $('quizTimelineBar');
  if (!bar) return;
  
  bar.style.width = '100%';
  bar.style.backgroundColor = '#e74c3c';
  
  if (quizTimer) clearInterval(quizTimer);
  
  const totalMs = 1650;
  const interval = 50;
  const steps = totalMs / interval;
  const stepPercent = 100 / steps;
  let currentStep = 0;
  
  quizTimer = setInterval(() => {
    if (!quizState) {
      clearInterval(quizTimer);
      return;
    }
    if (!quizState.isStarted) {
      clearInterval(quizTimer);
      return;
    }
    currentStep++;
    const newWidth = Math.max(0, 100 - (currentStep * stepPercent));
    bar.style.width = newWidth + '%';
    
    if (currentStep >= steps) {
      clearInterval(quizTimer);
      if (myId === quizState.randomPlayerId) {
        handleTimeout();
      }
    }
  }, interval);
}

function pauseTimeline() {
  if (quizTimer) {
    clearInterval(quizTimer);
    quizTimer = null;
  }
}

function resumeTimeline() {
  const bar = $('quizTimelineBar');
  if (bar) {
    bar.style.width = '100%';
    bar.style.backgroundColor = '#e74c3c';
  }
  startTimeline();
}

function checkAnswer(answer, btn) {
  if (!quizState || !quizState.isStarted) return;
  
  const answerBtns = document.querySelectorAll('.quiz-answer-btn');
  answerBtns.forEach(b => {
    b.disabled = true;
    b.style.background = 'transparent';
    b.style.color = '#fff';
  });
  
  pauseTimeline();
  
  const isCorrect = answer === quizState.correctAnswer;
  const btnIndex = parseInt(btn.dataset.index);
  
  socket.emit('quizAnswer', {
    answer,
    btnIndex,
    isCorrect,
    correctCount: quizState.correctCount + (isCorrect ? 1 : 0)
  });
  
  if (isCorrect) {
    quizState.correctCount++;
    btn.innerHTML = answer + '<span style="color:#2ecc71;">✓</span>';
    updateQuizGrid();
    
    if (quizState.correctCount >= 20) {
      endQuiz(true);
    } else {
      quizState.currentQuestion++;
      const questionData = generateQuestionData();
      socket.emit('quizNextQuestion', {
        questionText: questionData.questionText,
        answers: questionData.answers,
        correctAnswer: questionData.correctAnswer,
        correctCount: quizState.correctCount
      });
      setTimeout(() => {
        showQuestion(questionData.questionText, questionData.answers);
        resumeTimeline();
      }, 500);
    }
  } else {
    btn.innerHTML = answer + '<span style="color:#e74c3c;">✗</span>';
    endQuiz(false);
  }
}

socket.on('quizAnswer', ({ answer, btnIndex, isCorrect, correctCount }) => {
  if (!quizState) return;
  
  const answerBtns = document.querySelectorAll('.quiz-answer-btn');
  answerBtns.forEach(b => {
    b.disabled = true;
    b.style.background = 'transparent';
    b.style.color = '#fff';
  });
  
  const btn = answerBtns[btnIndex];
  if (btn) {
    if (isCorrect) {
      btn.innerHTML = answer + '<span style="color:#2ecc71;">✓</span>';
    } else {
      btn.innerHTML = answer + '<span style="color:#e74c3c;">✗</span>';
    }
  }
  
  if (isCorrect) {
    quizState.correctCount = correctCount;
    updateQuizGrid();
  }
});

socket.on('quizNextQuestion', ({ questionText, answers, correctAnswer, correctCount }) => {
  if (quizState) {
    quizState.currentQuestionText = questionText;
    quizState.correctAnswer = correctAnswer;
    quizState.answers = answers;
    quizState.correctCount = correctCount;
    updateQuizGrid();
    setTimeout(() => {
      showQuestion(questionText, answers);
      const bar = $('quizTimelineBar');
      if (bar) {
        bar.style.width = '100%';
        bar.style.backgroundColor = '#e74c3c';
      }
      startTimeline();
    }, 500);
  }
});

function updateQuizGrid() {
  const grid = $('quizGrid');
  if (!grid) return;
  
  const cells = grid.querySelectorAll('.quiz-grid-cell');
  cells.forEach((cell, i) => {
    if (i < quizState.correctCount) {
      cell.textContent = '✓';
    }
  });
}

function handleTimeout() {
  endQuiz(false, true);
}

function endQuiz(success, isTimeout = false) {
  if (!quizState) return;
  if (quizState.ended) return;
  quizState.ended = true;
  
  quizState.isStarted = false;
  pauseTimeline();
  
  const header = $('quizHeader');
  if (header) {
    const questionSpan = header.querySelector('span');
    const questionText = questionSpan ? questionSpan.textContent : quizState.currentQuestionText || '';
    header.innerHTML = `<span>${questionText}</span>`;
  }
  
  // 添加右上角红×关闭按钮
  const quizInner = document.querySelector('#quizPanel > div');
  if (quizInner && !quizInner.querySelector('.quiz-close-x')) {
    const closeX = document.createElement('div');
    closeX.className = 'quiz-close-x';
    closeX.style.cssText = 'position:absolute;top:8px;right:12px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;cursor:pointer;border-radius:50%;background:#e94560;z-index:101;user-select:none;';
    closeX.textContent = '×';
    closeX.onclick = () => {
      socket.emit('closeQuizPanel');
    };
    quizInner.appendChild(closeX);
  }
  
  if (myId === quizState.randomPlayerId) {
    socket.emit('hongkongQuizResult', {
      ownerId: quizState.ownerId,
      randomPlayerId: quizState.randomPlayerId,
      correctCount: quizState.correctCount,
      isTimeout,
      isZhilijiemu: quizState.isZhilijiemu || false
    });
  }
}

socket.on('closeQuizPanel', () => {
  closeQuizPanel();
});

function closeQuizPanel() {
  const panel = $('quizPanel');
  if (panel) panel.remove();
  quizState = null;
  if (quizTimer) {
    clearInterval(quizTimer);
    quizTimer = null;
  }
}

function showPokerChoice() {
  let btns = `<button id="randomTwoBtn" class="jail-btn">随机两人</button>`;
  btns += `<button id="selectOneBtn" class="jail-btn">指定1人</button>`;
  btns += `<button id="skipPokerBtn" class="jail-btn">放弃德州</button>`;
  document.getElementById('areaF').innerHTML = btns;
  $('randomTwoBtn').onclick = () => {
    socket.emit('texasRandomTwo');
    document.getElementById('areaF').innerHTML = '';
  };
  $('selectOneBtn').onclick = () => {
    $('areaE').textContent = '点击角色信息区指定一人';
    selectingTexasPlayer = true;
    document.getElementById('areaF').innerHTML = '';
  };
  $('skipPokerBtn').onclick = () => {
    socket.emit('texasSkip');
    document.getElementById('areaF').innerHTML = '';
  };
}

let selectingTexasPlayer = false;
let texasCards = [];
let texasSelectedCards = [];
let texasDiscardCount = 0;
let texasRoundCount = 0;
let texasPlayedHands = [];

document.addEventListener('click', (e) => {
});

socket.on('texasStart', ({ cards }) => {
  texasCards = cards;
  texasSelectedCards = [];
  texasDiscardCount = 0;
  texasRoundCount = 0;
  texasPlayedHands = [];
  showTexasPanel();
});

function showTexasWatchPanel(data) {
  let panel = document.getElementById('texasWatchPanel');
  if (panel) panel.remove();
  
  panel = document.createElement('div');
  panel.id = 'texasWatchPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;display:flex;flex-direction:column;background:#000;';
  
  const topArea = document.createElement('div');
  topArea.id = 'texasWatchP1Area';
  topArea.style.cssText = 'flex:1;display:flex;flex-direction:column;padding:10px;border-bottom:1px solid #333;';
  
  const topHeader = document.createElement('div');
  topHeader.style.cssText = 'display:flex;align-items:center;margin-bottom:5px;';
  const topLabel = document.createElement('div');
  topLabel.style.cssText = 'color:#fff;font-size:14px;margin-right:10px;';
  topLabel.innerHTML = `<span style="color:${data.player1Color}">●${data.player1}</span>`;
  topHeader.appendChild(topLabel);
  topArea.appendChild(topHeader);
  
  const topCardsRow1 = document.createElement('div');
  topCardsRow1.id = 'texasWatchP1Cards1';
  topCardsRow1.style.cssText = 'display:flex;gap:8px;justify-content:center;';
  data.player1Cards.slice(0, 4).forEach(c => {
    const img = document.createElement('img');
    img.src = `/drawable/pukepai/${c}.png`;
    img.style.cssText = 'height:60px;';
    topCardsRow1.appendChild(img);
  });
  topArea.appendChild(topCardsRow1);
  
  const topCardsRow2 = document.createElement('div');
  topCardsRow2.id = 'texasWatchP1Cards2';
  topCardsRow2.style.cssText = 'display:flex;gap:8px;margin-top:5px;justify-content:center;';
  data.player1Cards.slice(4, 8).forEach(c => {
    const img = document.createElement('img');
    img.src = `/drawable/pukepai/${c}.png`;
    img.style.cssText = 'height:60px;';
    topCardsRow2.appendChild(img);
  });
  topArea.appendChild(topCardsRow2);
  
  const topResults = document.createElement('div');
  topResults.id = 'texasWatchP1Results';
  topResults.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-top:10px;';
  for (let i = 0; i < 3; i++) {
    const cell = document.createElement('div');
    cell.className = 'texas-result-cell';
    topResults.appendChild(cell);
  }
  topArea.appendChild(topResults);
  
  const topButtons = document.createElement('div');
  topButtons.id = 'texasWatchP1Buttons';
  topButtons.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-top:10px;font-size:12px;color:#fff;';
  topArea.appendChild(topButtons);
  
  panel.appendChild(topArea);
  
  const bottomArea = document.createElement('div');
  bottomArea.id = 'texasWatchP2Area';
  bottomArea.style.cssText = 'flex:1;display:flex;flex-direction:column;padding:10px;';
  
  const bottomHeader = document.createElement('div');
  bottomHeader.style.cssText = 'display:flex;align-items:center;margin-bottom:5px;';
  const bottomLabel = document.createElement('div');
  bottomLabel.style.cssText = 'color:#fff;font-size:14px;margin-right:10px;';
  bottomLabel.innerHTML = `<span style="color:${data.player2Color}">●${data.player2}</span>`;
  bottomHeader.appendChild(bottomLabel);
  bottomArea.appendChild(bottomHeader);
  
  const bottomCardsRow1 = document.createElement('div');
  bottomCardsRow1.id = 'texasWatchP2Cards1';
  bottomCardsRow1.style.cssText = 'display:flex;gap:8px;justify-content:center;';
  data.player2Cards.slice(0, 4).forEach(c => {
    const img = document.createElement('img');
    img.src = `/drawable/pukepai/${c}.png`;
    img.style.cssText = 'height:60px;';
    bottomCardsRow1.appendChild(img);
  });
  bottomArea.appendChild(bottomCardsRow1);
  
  const bottomCardsRow2 = document.createElement('div');
  bottomCardsRow2.id = 'texasWatchP2Cards2';
  bottomCardsRow2.style.cssText = 'display:flex;gap:8px;margin-top:5px;justify-content:center;';
  data.player2Cards.slice(4, 8).forEach(c => {
    const img = document.createElement('img');
    img.src = `/drawable/pukepai/${c}.png`;
    img.style.cssText = 'height:60px;';
    bottomCardsRow2.appendChild(img);
  });
  bottomArea.appendChild(bottomCardsRow2);
  
  const bottomResults = document.createElement('div');
  bottomResults.id = 'texasWatchP2Results';
  bottomResults.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-top:10px;';
  for (let i = 0; i < 3; i++) {
    const cell = document.createElement('div');
    cell.className = 'texas-result-cell';
    bottomResults.appendChild(cell);
  }
  bottomArea.appendChild(bottomResults);
  
  const bottomButtons = document.createElement('div');
  bottomButtons.id = 'texasWatchP2Buttons';
  bottomButtons.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-top:10px;font-size:12px;color:#fff;';
  bottomArea.appendChild(bottomButtons);
  
  panel.appendChild(bottomArea);
  
  $('s1Area').appendChild(panel);
}

function showTexasPanel() {
  let panel = document.querySelector('.texas-panel');
  if (panel) panel.remove();
  
  panel = document.createElement('div');
  panel.className = 'texas-panel';
  
  const s1Area = document.getElementById('s1Area');
  if (s1Area) {
    s1Area.style.position = 'relative';
  }
  
  const row1 = document.createElement('div');
  row1.className = 'texas-row';
  row1.textContent = '出5张牌3次，K最大13分，同花顺额外+50，四条额外+5';
  panel.appendChild(row1);
  
  const row2 = document.createElement('div');
  row2.className = 'texas-row';
  row2.textContent = '同花顺＞四条＞3+2＞同花＞顺子＞3＞2+2＞2';
  panel.appendChild(row2);
  
  const row3 = document.createElement('div');
  row3.className = 'texas-row texas-results';
  for (let i = 0; i < 3; i++) {
    const cell = document.createElement('div');
    cell.className = 'texas-result-cell';
    cell.id = `texas-result-${i}`;
    row3.appendChild(cell);
  }
  panel.appendChild(row3);
  
  const cardArea = document.createElement('div');
  cardArea.className = 'texas-card-area';
  
  const row4 = document.createElement('div');
  row4.className = 'texas-cards';
  texasCards.slice(0, 4).forEach((card, i) => {
    const cardEl = document.createElement('img');
    cardEl.className = 'texas-card';
    cardEl.src = `/drawable/pukepai/${card}.png`;
    cardEl.dataset.index = i;
    cardEl.onclick = () => toggleCardSelection(i);
    row4.appendChild(cardEl);
  });
  cardArea.appendChild(row4);
  
  const row4b = document.createElement('div');
  row4b.className = 'texas-cards';
  texasCards.slice(4, 8).forEach((card, i) => {
    const cardEl = document.createElement('img');
    cardEl.className = 'texas-card';
    cardEl.src = `/drawable/pukepai/${card}.png`;
    cardEl.dataset.index = i + 4;
    cardEl.onclick = () => toggleCardSelection(i + 4);
    row4b.appendChild(cardEl);
  });
  cardArea.appendChild(row4b);
  panel.appendChild(cardArea);
  
  const row5 = document.createElement('div');
  row5.className = 'texas-buttons';
  
  const playBtn = document.createElement('button');
  playBtn.className = 'jail-btn';
  playBtn.id = 'texasPlayBtn';
  playBtn.textContent = '出牌';
  playBtn.disabled = true;
  playBtn.onclick = () => playCards();
  row5.appendChild(playBtn);
  
  const discardBtn = document.createElement('button');
  discardBtn.className = 'jail-btn';
  discardBtn.id = 'texasDiscardBtn';
  discardBtn.textContent = '弃牌';
  discardBtn.disabled = true;
  discardBtn.onclick = () => discardCards();
  row5.appendChild(discardBtn);
  
  const discardStars = document.createElement('div');
  discardStars.className = 'texas-stars';
  discardStars.id = 'texasStars';
  discardStars.textContent = '★★★';
  row5.appendChild(discardStars);
  
  panel.appendChild(row5);
  document.getElementById('s1Area').appendChild(panel);
}

let lunciMySelectedCard = null;

function showLunciPanel(data) {
  let panel = document.getElementById('lunciPanel');
  if (panel) panel.remove();
  
  const isPlayer = myId === data.currentPlayerId || myId === data.targetId;
  const isCurrent = myId === data.currentPlayerId;
  const isTarget = myId === data.targetId;
  const priorityName = data.priorityPlayerId === data.currentPlayerId ? data.currentPlayerName : data.targetName;
  const priorityColor = data.priorityPlayerId === data.currentPlayerId ? data.currentPlayerColor : data.targetColor;
  
  panel = document.createElement('div');
  panel.id = 'lunciPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;display:flex;flex-direction:column;background:url(/drawable/bj5.jpg) center/cover;';
  
  const myCards = isCurrent ? data.currentCards : data.targetCards;
  const opponentCards = isCurrent ? data.targetCards : data.currentCards;
  const myName = isCurrent ? data.currentPlayerName : data.targetName;
  const opponentName = isCurrent ? data.targetName : data.currentPlayerName;
  const myColor = isCurrent ? data.currentPlayerColor : data.targetColor;
  const opponentColor = isCurrent ? data.targetColor : data.currentPlayerColor;
  const mySum = myCards.reduce((s, c) => s + c.rank, 0);
  const opponentSum = opponentCards.reduce((s, c) => s + c.rank, 0);
  
  const topArea = document.createElement('div');
  topArea.id = 'lunciTopArea';
  topArea.style.cssText = 'flex:1;display:flex;align-items:center;padding:5px 10px;border-bottom:1px solid rgba(255,255,255,0.3);';
  const topLabel = document.createElement('div');
  topLabel.style.cssText = 'color:#fff;font-size:clamp(16px,4vw,24px);white-space:nowrap;margin-right:10px;';
  topLabel.innerHTML = `<span style="color:${opponentColor}">●${opponentName}</span>${opponentSum}`;
  topArea.appendChild(topLabel);
  const topCards = document.createElement('div');
  topCards.id = 'lunciOpponentCards';
  topCards.style.cssText = 'display:flex;gap:5px;flex:1;justify-content:center;';
  opponentCards.forEach(c => {
    const img = document.createElement('img');
    img.src = `/drawable/pukepai/${c.imageIndex}.png`;
    img.style.cssText = 'height:clamp(70px,14vw,120px);';
    topCards.appendChild(img);
  });
  topArea.appendChild(topCards);
  panel.appendChild(topArea);
  
  const midArea = document.createElement('div');
  midArea.id = 'lunciMidArea';
  midArea.style.cssText = 'flex:2;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:5px;';
  
  const midInfo = document.createElement('div');
  midInfo.id = 'lunciMidInfo';
  midInfo.style.cssText = 'color:#fff;font-size:clamp(14px,3.5vw,22px);text-align:center;margin-bottom:5px;';
  if (isPlayer) {
    midInfo.innerHTML = `<span style="color:${priorityColor}">●${priorityName}</span>先获得1张牌，下一轮点数小的先获得`;
  } else {
    midInfo.innerHTML = `<span style="color:${data.currentPlayerColor}">●${data.currentPlayerName}</span> vs <span style="color:${data.targetColor}">●${data.targetName}</span> 正在进行轮次`;
  }
  midArea.appendChild(midInfo);
  
  const cardsContainer = document.createElement('div');
  cardsContainer.style.cssText = 'display:flex;align-items:center;gap:15px;';
  
  const cardsLeft = document.createElement('div');
  cardsLeft.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
  
  const cardsRow1 = document.createElement('div');
  cardsRow1.id = 'lunciCardsRow1';
  cardsRow1.style.cssText = 'display:flex;gap:8px;';
  data.cards.slice(0, 3).forEach((c, i) => {
    const img = document.createElement('img');
    img.className = 'lunci-card';
    img.dataset.cardIndex = i;
    img.src = `/drawable/pukepai/${c.imageIndex}.png`;
    img.style.cssText = 'height:clamp(90px,18vw,150px);cursor:' + (isPlayer ? 'pointer' : 'default') + ';border:2px solid transparent;border-radius:4px;transition:border-color 0.2s;';
    if (isPlayer) {
      img.onclick = () => {
        document.querySelectorAll('.lunci-card').forEach(el => el.style.borderColor = 'transparent');
        img.style.borderColor = '#fff';
        lunciMySelectedCard = i;
        document.getElementById('lunciConfirmBtn').disabled = false;
      };
    }
    cardsRow1.appendChild(img);
  });
  cardsLeft.appendChild(cardsRow1);
  
  const cardsRow2 = document.createElement('div');
  cardsRow2.id = 'lunciCardsRow2';
  cardsRow2.style.cssText = 'display:flex;gap:8px;';
  data.cards.slice(3, 6).forEach((c, i) => {
    const img = document.createElement('img');
    img.className = 'lunci-card';
    img.dataset.cardIndex = i + 3;
    img.src = `/drawable/pukepai/${c.imageIndex}.png`;
    img.style.cssText = 'height:clamp(90px,18vw,150px);cursor:' + (isPlayer ? 'pointer' : 'default') + ';border:2px solid transparent;border-radius:4px;transition:border-color 0.2s;';
    if (isPlayer) {
      img.onclick = () => {
        document.querySelectorAll('.lunci-card').forEach(el => el.style.borderColor = 'transparent');
        img.style.borderColor = '#fff';
        lunciMySelectedCard = i + 3;
        document.getElementById('lunciConfirmBtn').disabled = false;
      };
    }
    cardsRow2.appendChild(img);
  });
  cardsLeft.appendChild(cardsRow2);
  cardsContainer.appendChild(cardsLeft);
  
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'jail-btn';
  confirmBtn.id = 'lunciConfirmBtn';
  confirmBtn.textContent = '确定';
  confirmBtn.disabled = true;
  confirmBtn.style.cssText = 'font-size:clamp(16px,4vw,24px);padding:8px 20px;display:' + (isPlayer ? 'inline-block' : 'none');
  confirmBtn.onclick = () => {
    if (lunciMySelectedCard !== null) {
      document.querySelectorAll('.lunci-card').forEach(el => {
        if (parseInt(el.dataset.cardIndex) === lunciMySelectedCard) {
          el.style.borderColor = '#ff0';
        }
        el.style.pointerEvents = 'none';
      });
      socket.emit('lunciSelectCard', { cardIndex: lunciMySelectedCard });
      lunciMySelectedCard = null;
      confirmBtn.disabled = true;
    }
  };
  cardsContainer.appendChild(confirmBtn);
  midArea.appendChild(cardsContainer);
  
  panel.appendChild(midArea);
  
  const bottomArea = document.createElement('div');
  bottomArea.id = 'lunciBottomArea';
  bottomArea.style.cssText = 'flex:1;display:flex;align-items:center;padding:5px 10px;border-top:1px solid rgba(255,255,255,0.3);';
  const bottomLabel = document.createElement('div');
  bottomLabel.style.cssText = 'color:#fff;font-size:clamp(16px,4vw,24px);white-space:nowrap;margin-right:10px;';
  bottomLabel.innerHTML = `<span style="color:${myColor}">●${myName}</span>${mySum}`;
  bottomArea.appendChild(bottomLabel);
  const bottomCards = document.createElement('div');
  bottomCards.id = 'lunciMyCards';
  bottomCards.style.cssText = 'display:flex;gap:5px;flex:1;justify-content:center;';
  myCards.forEach(c => {
    const img = document.createElement('img');
    img.src = `/drawable/pukepai/${c.imageIndex}.png`;
    img.style.cssText = 'height:clamp(70px,14vw,120px);';
    bottomCards.appendChild(img);
  });
  bottomArea.appendChild(bottomCards);
  panel.appendChild(bottomArea);
  
  document.getElementById('game').appendChild(panel);
}

function updateLunciPanel(data) {
  const panel = document.getElementById('lunciPanel');
  if (!panel) return;
  
  const isPlayer = myId === data.currentPlayerId || myId === data.targetId;
  const isCurrent = myId === data.currentPlayerId;
  const priorityName = data.priorityPlayerId === data.currentPlayerId ? data.currentPlayerName : data.targetName;
  const priorityColor = data.priorityPlayerId === data.currentPlayerId ? data.currentPlayerColor : data.targetColor;
  
  const myCards = isCurrent ? data.currentCards : data.targetCards;
  const opponentCards = isCurrent ? data.targetCards : data.currentCards;
  const myName = isCurrent ? data.currentPlayerName : data.targetName;
  const opponentName = isCurrent ? data.targetName : data.currentPlayerName;
  const myColor = isCurrent ? data.currentPlayerColor : data.targetColor;
  const opponentColor = isCurrent ? data.targetColor : data.currentPlayerColor;
  
  const mySum = myCards.reduce((s, c) => s + c.rank, 0);
  const opponentSum = opponentCards.reduce((s, c) => s + c.rank, 0);
  const prioritySum = (priorityName === myName) ? mySum : opponentSum;
  
  lunciMySelectedCard = null;
  
  const midInfo = document.getElementById('lunciMidInfo');
  if (midInfo) {
    if (isPlayer) {
      midInfo.innerHTML = `<span style="color:${priorityColor}">●${priorityName}</span>先获得1张牌，下一轮点数小的先获得`;
    }
  }
  
  const confirmBtn = document.getElementById('lunciConfirmBtn');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.style.display = isPlayer ? 'inline-block' : 'none';
  }
  
  const topArea = document.getElementById('lunciTopArea');
  if (topArea) {
    const topLabel = topArea.querySelector('div');
    if (topLabel) topLabel.innerHTML = `<span style="color:${opponentColor}">●${opponentName}</span>${opponentSum}`;
  }
  
  const topCards = document.getElementById('lunciOpponentCards');
  if (topCards) {
    topCards.innerHTML = '';
    opponentCards.forEach(c => {
      const img = document.createElement('img');
      img.src = `/drawable/pukepai/${c.imageIndex}.png`;
      img.style.cssText = 'height:clamp(70px,14vw,120px);';
      topCards.appendChild(img);
    });
  }
  
  const bottomArea = document.getElementById('lunciBottomArea');
  if (bottomArea) {
    const bottomLabel = bottomArea.querySelector('div');
    if (bottomLabel) bottomLabel.innerHTML = `<span style="color:${myColor}">●${myName}</span>${mySum}`;
  }
  
  const bottomCards = document.getElementById('lunciMyCards');
  if (bottomCards) {
    bottomCards.innerHTML = '';
    myCards.forEach(c => {
      const img = document.createElement('img');
      img.src = `/drawable/pukepai/${c.imageIndex}.png`;
      img.style.cssText = 'height:clamp(70px,14vw,120px);';
      bottomCards.appendChild(img);
    });
  }
  
  const cardsRow1 = document.getElementById('lunciCardsRow1');
  if (cardsRow1) {
    cardsRow1.innerHTML = '';
    const cardsCount = Math.min(data.cards.length, 3);
    for (let i = 0; i < cardsCount; i++) {
      const c = data.cards[i];
      const img = document.createElement('img');
      img.className = 'lunci-card';
      img.dataset.cardIndex = i;
      img.src = `/drawable/pukepai/${c.imageIndex}.png`;
      img.style.cssText = 'height:clamp(90px,18vw,150px);cursor:' + (isPlayer ? 'pointer' : 'default') + ';border:2px solid transparent;border-radius:4px;transition:border-color 0.2s;';
      if (isPlayer) {
        img.onclick = () => {
          document.querySelectorAll('.lunci-card').forEach(el => el.style.borderColor = 'transparent');
          img.style.borderColor = '#fff';
          lunciMySelectedCard = i;
          confirmBtn.disabled = false;
        };
      }
      cardsRow1.appendChild(img);
    }
  }
  
  const cardsRow2 = document.getElementById('lunciCardsRow2');
  if (cardsRow2) {
    cardsRow2.innerHTML = '';
    if (data.cards.length > 3) {
      for (let i = 3; i < data.cards.length; i++) {
        const c = data.cards[i];
        const img = document.createElement('img');
        img.className = 'lunci-card';
        img.dataset.cardIndex = i;
        img.src = `/drawable/pukepai/${c.imageIndex}.png`;
        img.style.cssText = 'height:clamp(90px,18vw,150px);cursor:' + (isPlayer ? 'pointer' : 'default') + ';border:2px solid transparent;border-radius:4px;transition:border-color 0.2s;';
        if (isPlayer) {
          img.onclick = () => {
            document.querySelectorAll('.lunci-card').forEach(el => el.style.borderColor = 'transparent');
            img.style.borderColor = '#fff';
            lunciMySelectedCard = i;
            confirmBtn.disabled = false;
          };
        }
        cardsRow2.appendChild(img);
      }
    }
  }
}

function updateLunciCardSelection(playerId, cardIndex) {
  const panel = document.getElementById('lunciPanel');
  if (!panel) return;
  if (playerId === myId) return;
  
  document.querySelectorAll('.lunci-card').forEach(el => {
    if (parseInt(el.dataset.cardIndex) === cardIndex) {
      el.style.borderColor = '#ff0';
    }
  });
}

function showLunciResult(data) {
  const panel = document.getElementById('lunciPanel');
  if (!panel) return;
  
  const isCurrent = myId === data.currentPlayerId;
  const myCards = isCurrent ? data.currentCards : data.targetCards;
  const opponentCards = isCurrent ? data.targetCards : data.currentCards;
  const myName = isCurrent ? data.currentPlayerName : data.targetName;
  const opponentName = isCurrent ? data.targetName : data.currentPlayerName;
  const myColor = isCurrent ? data.currentPlayerColor : data.targetColor;
  const opponentColor = isCurrent ? data.targetColor : data.currentPlayerColor;
  const mySum = myCards.reduce((s, c) => s + c.rank, 0);
  const opponentSum = opponentCards.reduce((s, c) => s + c.rank, 0);
  
  const topArea = document.getElementById('lunciTopArea');
  if (topArea) {
    const topLabel = topArea.querySelector('div');
    if (topLabel) topLabel.innerHTML = `<span style="color:${opponentColor}">●${opponentName}</span>${opponentSum}`;
  }
  
  const topCards = document.getElementById('lunciOpponentCards');
  if (topCards) {
    topCards.innerHTML = '';
    opponentCards.forEach(c => {
      const img = document.createElement('img');
      img.src = `/drawable/pukepai/${c.imageIndex}.png`;
      img.style.cssText = 'height:clamp(70px,14vw,120px);';
      topCards.appendChild(img);
    });
  }
  
  const bottomArea = document.getElementById('lunciBottomArea');
  if (bottomArea) {
    const bottomLabel = bottomArea.querySelector('div');
    if (bottomLabel) bottomLabel.innerHTML = `<span style="color:${myColor}">●${myName}</span>${mySum}`;
  }
  
  const bottomCards = document.getElementById('lunciMyCards');
  if (bottomCards) {
    bottomCards.innerHTML = '';
    myCards.forEach(c => {
      const img = document.createElement('img');
      img.src = `/drawable/pukepai/${c.imageIndex}.png`;
      img.style.cssText = 'height:clamp(70px,14vw,120px);';
      bottomCards.appendChild(img);
    });
  }
  
  const midArea = document.getElementById('lunciMidArea');
  if (midArea) {
    midArea.innerHTML = '';
    
    const resultInfo = document.createElement('div');
    resultInfo.style.cssText = 'color:#fff;font-size:16px;text-align:center;margin-bottom:10px;';
    resultInfo.innerHTML = data.resultMessage || '平局';
    midArea.appendChild(resultInfo);
  }
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'jail-btn';
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'position:absolute;top:5px;right:5px;background:rgba(255,0,0,0.7);color:#fff;font-size:20px;padding:2px 8px;border:none;border-radius:4px;cursor:pointer;z-index:101;';
  closeBtn.onclick = () => socket.emit('lunciClose');
  if (myId === data.currentPlayerId) {
    panel.appendChild(closeBtn);
  }
}

function toggleCardSelection(index) {
  const cardEl = document.querySelector(`.texas-card[data-index="${index}"]`);
  if (!cardEl) return;
  
  if (texasSelectedCards.includes(index)) {
    texasSelectedCards = texasSelectedCards.filter(i => i !== index);
    cardEl.classList.remove('selected');
  } else if (texasSelectedCards.length < 8) {
    texasSelectedCards.push(index);
    cardEl.classList.add('selected');
  }
  
  updateTexasButtons();
}

function updateTexasButtons() {
  const playBtn = $('texasPlayBtn');
  const discardBtn = $('texasDiscardBtn');
  
  if (playBtn) playBtn.disabled = texasSelectedCards.length !== 5;
  if (discardBtn) {
    if (texasDiscardCount >= 3) {
      discardBtn.style.display = 'none';
    } else {
      discardBtn.style.display = '';
      discardBtn.disabled = texasSelectedCards.length === 0;
    }
  }
}

function discardCards() {
  if (texasSelectedCards.length === 0 || texasDiscardCount >= 3) return;
  
  socket.emit('texasDiscard', texasSelectedCards);
  texasSelectedCards = [];
  texasDiscardCount++;
  
  const stars = $('texasStars');
  if (stars) {
    stars.textContent = '★'.repeat(3 - texasDiscardCount);
  }
  
  updateTexasButtons();
}

function playCards() {
  if (texasSelectedCards.length !== 5) return;
  
  socket.emit('texasPlay', texasSelectedCards);
  texasRoundCount++;
}

socket.on('texasUpdateCards', ({ cards, discardCount }) => {
  texasCards = cards;
  texasSelectedCards = [];
  texasDiscardCount = discardCount;
  
  const cardsContainers = document.querySelectorAll('.texas-cards');
  if (cardsContainers.length >= 2) {
    cardsContainers[0].innerHTML = '';
    cardsContainers[1].innerHTML = '';
    texasCards.slice(0, 4).forEach((card, i) => {
      const cardEl = document.createElement('img');
      cardEl.className = 'texas-card';
      cardEl.src = `/drawable/pukepai/${card}.png`;
      cardEl.dataset.index = i;
      cardEl.onclick = () => toggleCardSelection(i);
      cardsContainers[0].appendChild(cardEl);
    });
    texasCards.slice(4, 8).forEach((card, i) => {
      const cardEl = document.createElement('img');
      cardEl.className = 'texas-card';
      cardEl.src = `/drawable/pukepai/${card}.png`;
      cardEl.dataset.index = i + 4;
      cardEl.onclick = () => toggleCardSelection(i + 4);
      cardsContainers[1].appendChild(cardEl);
    });
  }
  
  updateTexasButtons();
});

socket.on('texasShowResult', ({ result, roundCount, cards }) => {
  const cell = $(`texas-result-${roundCount - 1}`);
  if (cell) {
    cell.textContent = `${result.type}\n${result.score}`;
  }
  texasPlayedHands.push(result);
  
  if (roundCount >= 3) {
    const row3 = document.querySelector('.texas-results');
    if (row3) row3.style.display = 'none';
    
    const cardsContainers = document.querySelectorAll('.texas-cards');
    if (cardsContainers.length >= 2) {
      cardsContainers[0].innerHTML = '';
      for (let i = 0; i < 3; i++) {
        const c = document.createElement('div');
        c.className = 'texas-result-cell';
        if (texasPlayedHands[i]) {
          c.textContent = `${texasPlayedHands[i].type}\n${texasPlayedHands[i].score}`;
        }
        cardsContainers[0].appendChild(c);
      }
      cardsContainers[1].innerHTML = '';
      for (let i = 0; i < 3; i++) {
        const emptyCell = document.createElement('div');
        emptyCell.className = 'texas-result-cell';
        cardsContainers[1].appendChild(emptyCell);
      }
    }
    
    const row5 = document.querySelector('.texas-buttons');
    if (row5) {
      row5.innerHTML = '<div>等待最终结果…</div>';
    }
  } else if (cards) {
    texasCards = cards;
    texasSelectedCards = [];
    const cardsContainers = document.querySelectorAll('.texas-cards');
    if (cardsContainers.length >= 2) {
      cardsContainers[0].innerHTML = '';
      cardsContainers[1].innerHTML = '';
      texasCards.slice(0, 4).forEach((card, i) => {
        const cardEl = document.createElement('img');
        cardEl.className = 'texas-card';
        cardEl.src = `/drawable/pukepai/${card}.png`;
        cardEl.dataset.index = i;
        cardEl.onclick = () => toggleCardSelection(i);
        cardsContainers[0].appendChild(cardEl);
      });
      texasCards.slice(4, 8).forEach((card, i) => {
        const cardEl = document.createElement('img');
        cardEl.className = 'texas-card';
        cardEl.src = `/drawable/pukepai/${card}.png`;
        cardEl.dataset.index = i + 4;
        cardEl.onclick = () => toggleCardSelection(i + 4);
        cardsContainers[1].appendChild(cardEl);
      });
    }
  }
});

socket.on('texasWaiting', () => {
  const row5 = document.querySelector('.texas-buttons');
  if (row5) {
    row5.innerHTML = '<div>请等待对方出牌…</div>';
  }
});

socket.on('texasWatchResult', ({ hands, name, color, cards, discardCount, roundCount }) => {
});

socket.on('texasWatchUpdate', ({ playerId, isPlayer1, hands, cards, name, color, roundCount, discardCount }) => {
  const watchPanel = document.getElementById('texasWatchPanel');
  if (!watchPanel) return;
  
  const cards1Id = isPlayer1 ? 'texasWatchP1Cards1' : 'texasWatchP2Cards1';
  const cards2Id = isPlayer1 ? 'texasWatchP1Cards2' : 'texasWatchP2Cards2';
  const resultsId = isPlayer1 ? 'texasWatchP1Results' : 'texasWatchP2Results';
  const buttonsId = isPlayer1 ? 'texasWatchP1Buttons' : 'texasWatchP2Buttons';
  
  const cards1El = document.getElementById(cards1Id);
  const cards2El = document.getElementById(cards2Id);
  const resultsEl = document.getElementById(resultsId);
  const buttonsEl = document.getElementById(buttonsId);
  
  if (cards1El && cards) {
    cards1El.innerHTML = '';
    cards.slice(0, 4).forEach(c => {
      const img = document.createElement('img');
      img.src = `/drawable/pukepai/${c}.png`;
      img.style.cssText = 'height:60px;';
      cards1El.appendChild(img);
    });
  }
  
  if (cards2El && cards) {
    cards2El.innerHTML = '';
    cards.slice(4, 8).forEach(c => {
      const img = document.createElement('img');
      img.src = `/drawable/pukepai/${c}.png`;
      img.style.cssText = 'height:60px;';
      cards2El.appendChild(img);
    });
  }
  
  if (resultsEl) {
    resultsEl.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const cell = document.createElement('div');
      cell.className = 'texas-result-cell';
      if (hands && hands[i]) {
        cell.textContent = `${hands[i].type}\n${hands[i].score}`;
      }
      resultsEl.appendChild(cell);
    }
  }
});

socket.on('texasWatchRoundResult', ({ roundIndex, p1Hand, p2Hand, result }) => {
  const p1Results = document.getElementById('texasWatchP1Results');
  const p2Results = document.getElementById('texasWatchP2Results');
  
  if (p1Results && p1Results.children[roundIndex]) {
    const cell = p1Results.children[roundIndex];
    cell.textContent = `${p1Hand.type}\n${p1Hand.score}`;
    if (result === 'win') {
      const check = document.createElement('div');
      check.className = 'texas-win-check';
      check.textContent = '✓';
      cell.appendChild(check);
    }
  }
  
  if (p2Results && p2Results.children[roundIndex]) {
    const cell = p2Results.children[roundIndex];
    cell.textContent = `${p2Hand.type}\n${p2Hand.score}`;
    if (result === 'lose') {
      const check = document.createElement('div');
      check.className = 'texas-win-check';
      check.textContent = '✓';
      cell.appendChild(check);
    }
  }
});

socket.on('texasWatchFinalResult', ({ player1Name, player1Color, player2Name, player2Color, p1Hands, p2Hands, results }) => {
  const watchPanel = document.getElementById('texasWatchPanel');
  if (watchPanel) {
    const p1Results = document.getElementById('texasWatchP1Results');
    const p2Results = document.getElementById('texasWatchP2Results');
    const p1Buttons = document.getElementById('texasWatchP1Buttons');
    const p2Buttons = document.getElementById('texasWatchP2Buttons');
    
    if (p1Results) {
      p1Results.innerHTML = '';
      for (let i = 0; i < 3; i++) {
        const cell = document.createElement('div');
        cell.className = 'texas-result-cell';
        if (p1Hands[i]) {
          cell.textContent = `${p1Hands[i].type}\n${p1Hands[i].score}`;
        }
        if (results[i] === '胜') {
          const check = document.createElement('div');
          check.className = 'texas-win-check';
          check.textContent = '✓';
          cell.appendChild(check);
        }
        p1Results.appendChild(cell);
      }
    }
    
    if (p2Results) {
      p2Results.innerHTML = '';
      for (let i = 0; i < 3; i++) {
        const cell = document.createElement('div');
        cell.className = 'texas-result-cell';
        if (p2Hands[i]) {
          cell.textContent = `${p2Hands[i].type}\n${p2Hands[i].score}`;
        }
        if (results[i] === '负') {
          const check = document.createElement('div');
          check.className = 'texas-win-check';
          check.textContent = '✓';
          cell.appendChild(check);
        }
        p2Results.appendChild(cell);
      }
    }
    
    if (p1Buttons) {
      p1Buttons.textContent = results.join(', ');
    }
    if (p2Buttons) {
      p2Buttons.textContent = results.map(r => r === '胜' ? '负' : r === '负' ? '胜' : '平').join(', ');
    }
  }
});

socket.on('texasFinalResult', ({ myHands, opponentHands, results }) => {
  const cardsContainers = document.querySelectorAll('.texas-cards');
  if (cardsContainers.length >= 2) {
    cardsContainers[0].innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const c = document.createElement('div');
      c.className = 'texas-result-cell';
      if (myHands[i]) {
        c.textContent = `${myHands[i].type}\n${myHands[i].score}`;
      }
      if (results[i] === '胜') {
        const check = document.createElement('div');
        check.className = 'texas-win-check';
        check.textContent = '✓';
        c.appendChild(check);
      }
      cardsContainers[0].appendChild(c);
    }
    cardsContainers[1].innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const c = document.createElement('div');
      c.className = 'texas-result-cell texas-opponent-cell';
      if (opponentHands[i]) {
        c.textContent = `${opponentHands[i].type}\n${opponentHands[i].score}`;
      }
      if (results[i] === '败') {
        const check = document.createElement('div');
        check.className = 'texas-win-check';
        check.textContent = '✓';
        c.appendChild(check);
      }
      cardsContainers[1].appendChild(c);
    }
  }
  
  const row5 = document.querySelector('.texas-buttons');
  if (row5) {
    row5.innerHTML = '';
    const resultDiv = document.createElement('div');
    resultDiv.textContent = results.join(', ');
    row5.appendChild(resultDiv);
  }
  
  const panel = document.querySelector('.texas-panel');
  if (panel) {
    const closeBtn = document.createElement('div');
    closeBtn.className = 'texas-close-btn';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => {
      panel.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#fff;font-size:20px;">请等待对方关闭面板</div>';
      socket.emit('texasClose');
    };
    panel.appendChild(closeBtn);
  }
});

socket.on('texasRoundResult', ({ myHand, opponentHand, result }) => {
});

socket.on('texasWatchClose', () => {
  const watchPanel = document.getElementById('texasWatchPanel');
  if (watchPanel) watchPanel.remove();
});

socket.on('texasPanelClose', ({ showEndTurn } = {}) => {
  const panel = document.querySelector('.texas-panel');
  if (panel) panel.remove();
  document.querySelectorAll('.player-card').forEach(card => {
    card.style.cursor = '';
    card.onclick = null;
  });
  if (showEndTurn) {
    document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    const endTurnBtn = document.getElementById('endTurnBtn');
    if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
  }
});

socket.on('texasEnd', () => {
  const watchPanel = document.getElementById('texasWatchPanel');
  if (watchPanel) watchPanel.remove();
  document.querySelectorAll('.player-card').forEach(card => {
    card.style.cursor = '';
    card.onclick = null;
  });
  document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
  const endTurnBtn = document.getElementById('endTurnBtn');
  if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
});

socket.on('texasPlayers', ({ player1, player2, player1Color, player2Color, player1Id, player2Id, player1Cards, player2Cards }) => {
  $('areaE').innerHTML = `${coloredName(player1, player1Color)} vs ${coloredName(player2, player2Color)}`;
  
  if (myId !== player1Id && myId !== player2Id) {
    showTexasWatchPanel({ player1, player2, player1Color, player2Color, player1Id, player2Id, player1Cards, player2Cards });
  }
});

startBtn.onclick = () => {
  console.log('[DEBUG] startBtn clicked, gameState=', window.gameState);
  startBtn.disabled = true;
  socket.emit('startGame');
};

const settingsWrapper = $('settingsWrapper');
const settingsBtn = $('settingsBtn');
const settingsDropdown = $('settingsDropdown');
const saveGameBtn3 = $('saveGameBtn3');

if (settingsBtn) {
  settingsBtn.onclick = () => {
    if (settingsDropdown) {
      settingsDropdown.classList.toggle('hidden');
    }
  };
}

if (restartBtn2) {
  restartBtn2.onclick = () => {
    socket.emit('restartServer');
    if (settingsDropdown) settingsDropdown.classList.add('hidden');
  };
}

if (saveGameBtn3) {
  saveGameBtn3.onclick = () => {
    const areaF = document.getElementById('areaF');
    const areaG = document.getElementById('areaG');
    socket.emit('saveGame', {
      areaFContent: areaF ? areaF.innerHTML : '',
      areaGContent: areaG ? areaG.innerHTML : ''
    });
    if (settingsDropdown) settingsDropdown.classList.add('hidden');
  };
}

const disconnectBtn2 = $('disconnectBtn2');
if (disconnectBtn2) {
  disconnectBtn2.onclick = () => {
    socket.disconnect();
    isDisconnected = true;
    $('gameContainer')?.classList.add('hidden');
    $('actionBar')?.classList.add('hidden');
    $('bottomBar')?.classList.add('hidden');
    if (settingsDropdown) settingsDropdown.classList.add('hidden');
  };
}

const cardsAndPropertiesBtn = $('cardsAndPropertiesBtn');
if (cardsAndPropertiesBtn) {
  cardsAndPropertiesBtn.onclick = () => {
    socket.emit('testCards');
    socket.emit('distributeProperties');
    if (settingsDropdown) settingsDropdown.classList.add('hidden');
  };
}

const testPetBtn = $('testPetBtn');
if (testPetBtn) {
  testPetBtn.onclick = () => {
    socket.emit('testGivePet');
  };
}

const flipAllPetBtn = $('flipAllPetBtn');
if (flipAllPetBtn) {
  flipAllPetBtn.onclick = () => {
    socket.emit('flipAllPets');
    if (settingsDropdown) settingsDropdown.classList.add('hidden');
  };
}

const testJiyuBtn = $('testJiyuBtn');
if (testJiyuBtn) {
  testJiyuBtn.onclick = () => {
    socket.emit('testJiyu');
    if (settingsDropdown) settingsDropdown.classList.add('hidden');
  };
}

const testSansiBtn = $('testSansiBtn');
if (testSansiBtn) {
  testSansiBtn.onclick = () => {
    socket.emit('testSansi');
  };
}

const testQiyuBtn = $('testQiyuBtn');
if (testQiyuBtn) {
  testQiyuBtn.onclick = () => {
    socket.emit('testQiyu');
    if (settingsDropdown) settingsDropdown.classList.add('hidden');
  };
}

const clearBugBtn = $('clearBugBtn');
if (clearBugBtn) {
  clearBugBtn.onclick = () => {
    socket.emit('clearBug');
    if (settingsDropdown) settingsDropdown.classList.add('hidden');
  };
}

const testFreezeBtn = $('testFreezeBtn');
if (testFreezeBtn) {
  testFreezeBtn.onclick = () => {
    socket.emit('testFreeze');
    if (settingsDropdown) settingsDropdown.classList.add('hidden');
  };
}

const consoleBtn = $('consoleBtn');
if (consoleBtn) {
  consoleBtn.onclick = () => {
    if (settingsDropdown) settingsDropdown.classList.add('hidden');
    let panel = $('consolePanel');
    if (panel) { panel.remove(); return; }
    panel = document.createElement('div');
    panel.id = 'consolePanel';
    panel.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.95);z-index:9999;display:flex;flex-direction:column;padding:8px;';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="color:#0f0;font-size:16px;font-weight:bold;">控制台</span>
        <div style="display:flex;gap:8px;">
          <button id="consoleCopyBtn" style="background:#333;color:#fff;border:none;border-radius:4px;padding:4px 12px;font-size:14px;cursor:pointer;">复制</button>
          <button id="consoleCloseBtn" style="background:#e74c3c;color:#fff;border:none;border-radius:4px;padding:4px 12px;font-size:14px;cursor:pointer;">关闭</button>
        </div>
      </div>
      <div id="consoleContent" style="flex:1;overflow-y:auto;color:#0f0;font-size:12px;font-family:monospace;white-space:pre-wrap;word-break:break-all;"></div>
    `;
    document.body.appendChild(panel);
    const content = $('consoleContent');
    if (content) content.textContent = _consoleLogs.join('\n');
    $('consoleCloseBtn').onclick = () => panel.remove();
    $('consoleCopyBtn').onclick = () => {
      const text = _consoleLogs.join('\n');
      const btn = $('consoleCopyBtn');
      const showSuccess = () => {
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      };
      const showFail = () => {
        btn.textContent = '复制失败';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      };
      // 优先使用 Clipboard API（异步，安卓 WebView 较安全）
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(showSuccess).catch(() => {
          // Clipboard API 失败时回退到 execCommand
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;';
            document.body.appendChild(ta);
            // 不调用 focus()，避免安卓触发软键盘崩溃
            ta.select();
            ta.setSelectionRange(0, ta.value.length);
            let ok = false;
            try { ok = document.execCommand('copy'); } catch(e) {}
            ta.remove();
            if (ok) { showSuccess(); } else { showFail(); }
          } catch (err) {
            showFail();
          }
        });
        return;
      }
      // 无 Clipboard API 时使用 execCommand
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        let ok = false;
        try { ok = document.execCommand('copy'); } catch(e) {}
        ta.remove();
        if (ok) { showSuccess(); } else { showFail(); }
      } catch (err) {
        showFail();
      }
    };
    content.scrollTop = content.scrollHeight;
  };
}

function showDiceSelectInF(minDice = 1, maxDice = 6, callback = null) {
  const areaF = $('areaF');
  if (!areaF) return;
  
  const existing = $('diceSelectInF');
  if (existing) { existing.remove(); return; }
  
  // 上三下三布局：1-3 上排，4-6 下排
  const diceList = [];
  for (let i = minDice; i <= maxDice; i++) diceList.push(i);
  const half = Math.ceil(diceList.length / 2);
  const topRow = diceList.slice(0, half);
  const bottomRow = diceList.slice(half);
  
  let html = '<div id="diceSelectInF" style="display:flex;flex-direction:column;gap:2px;justify-content:center;align-items:center;">';
  html += '<div style="display:flex;gap:5px;justify-content:center;align-items:center;">';
  topRow.forEach(i => {
    html += `<img src="/drawable/touzi/T${i}.png" style="height:27px;width:27px;cursor:pointer;border-radius:4px;" class="dice-select-img" data-dice="${i}">`;
  });
  html += '</div>';
  if (bottomRow.length > 0) {
    html += '<div style="display:flex;gap:5px;justify-content:center;align-items:center;">';
    bottomRow.forEach(i => {
      html += `<img src="/drawable/touzi/T${i}.png" style="height:27px;width:27px;cursor:pointer;border-radius:4px;" class="dice-select-img" data-dice="${i}">`;
    });
    html += '</div>';
  }
  html += '</div>';
  areaF.innerHTML = html;
  
  areaF.querySelectorAll('.dice-select-img').forEach(img => {
    img.onclick = () => {
      const diceValue = parseInt(img.dataset.dice);
      if (callback) {
        callback(diceValue);
      } else {
        socket.emit('selectDiceValue', { diceValue });
      }
      areaF.innerHTML = '';
    };
  });
}

document.addEventListener('click', (e) => {
  if (settingsWrapper && !settingsWrapper.contains(e.target)) {
    if (settingsDropdown) settingsDropdown.classList.add('hidden');
  }
});

socket.on('saveGameResult', ({ success }) => {
  if (success) {
    $('areaE').innerHTML = '游戏已保存';
    fitAreaEText();
  }
});

function showConfirmDialog(message, onConfirm) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:10000;';
  
  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#2d2d2d;padding:30px;border-radius:10px;text-align:center;color:#fff;min-width:250px;';
  
  const msg = document.createElement('div');
  msg.textContent = message;
  msg.style.cssText = 'font-size:20px;margin-bottom:25px;';
  dialog.appendChild(msg);
  
  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = 'display:flex;gap:15px;justify-content:center;';
  
  const yesBtn = document.createElement('button');
  yesBtn.textContent = '是';
  yesBtn.style.cssText = 'padding:10px 30px;font-size:16px;border:none;border-radius:5px;background:#00b894;color:#fff;cursor:pointer;';
  yesBtn.onclick = () => {
    overlay.remove();
    onConfirm();
  };
  
  const noBtn = document.createElement('button');
  noBtn.textContent = '否';
  noBtn.style.cssText = 'padding:10px 30px;font-size:16px;border:none;border-radius:5px;background:#d63031;color:#fff;cursor:pointer;';
  noBtn.onclick = () => {
    overlay.remove();
  };
  
  btnContainer.appendChild(yesBtn);
  btnContainer.appendChild(noBtn);
  dialog.appendChild(btnContainer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
}

emojiBtn.onclick = () => {
  showEmojiPanel();
};

if (testDiceBtn) {
  testDiceBtn.onclick = () => {
    if (!dicePickerVisible) showDicePicker();
  };
}

const quickStartBtn = $('quickStartBtn');
if (quickStartBtn) {
  quickStartBtn.onclick = () => {
    quickStartBtn.disabled = true;
    socket.emit('quickStart');
  };
}

const loadGameBtn = $('loadGameBtn');
const deleteSaveBtn = $('deleteSaveBtn');
const saveBtnRow = $('saveBtnRow');
if (loadGameBtn) {
  socket.emit('checkSaveGame');
}

socket.on('checkSaveGameResult', ({ exists }) => {
  if (saveBtnRow) {
    if (exists) {
      saveBtnRow.classList.remove('hidden');
    } else {
      saveBtnRow.classList.add('hidden');
    }
  }
});

if (loadGameBtn) {
  loadGameBtn.onclick = () => {
    loadGameBtn.disabled = true;
    socket.emit('loadGame');
  };
}

if (deleteSaveBtn) {
  deleteSaveBtn.onclick = () => {
    socket.emit('deleteSaveGame');
  };
}

socket.on('deleteSaveGameResult', ({ success }) => {
  if (success) {
    if (saveBtnRow) saveBtnRow.classList.add('hidden');
  }
});

socket.on('loadGameResult', ({ success, error }) => {
  if (!success) {
    alert(error || '载入失败');
    if (loadGameBtn) loadGameBtn.disabled = false;
  }
});

socket.on('loadGameSuccess', ({ players: p, board: b, gameState: gs, currentPlayerIndex: cpi, selectedCharacters: sel }) => {
  players = p;
  board = b;
  currentPlayerIdx = cpi;
  selectedCharacters = sel || {};
  isLoadedGame = true;
  
  const lobby = $('lobby');
  const game = $('game');
  if (game) game.classList.add('hidden');
  if (lobby) lobby.classList.remove('hidden');
  
  showLoadedGameCharacterSelect();
});

function showLoadedGameCharacterSelect() {
  const lobby = $('lobby');
  if (!lobby) return;
  
  const loadedSelectedChars = {};
  
  let html = '<div class="lobby-container" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;">';
  html += '<div style="font-size:24px;color:#fff;margin-bottom:20px;">选择你的角色</div>';
  
  const activePlayers = players.filter(p => !p.bankrupt);
  const rows = [];
  for (let i = 0; i < activePlayers.length; i += 3) {
    rows.push(activePlayers.slice(i, i + 3));
  }
  
  html += '<div style="display:flex;flex-direction:column;gap:20px;">';
  rows.forEach(row => {
    html += '<div style="display:flex;gap:20px;justify-content:center;">';
    row.forEach(p => {
      const charKey = p.character + (p.variant || '');
      html += `<div class="loaded-char-box" data-player-id="${p.id}" data-player-name="${p.name}" data-character="${p.character}" data-variant="${p.variant || ''}" style="display:flex;flex-direction:column;align-items:center;cursor:pointer;padding:10px;background:rgba(255,255,255,0.1);border-radius:8px;border:2px solid transparent;transition:all 0.3s;">`;
      html += `<img src="/drawable/juese/${p.character}${p.variant || '2'}.png" style="width:80px;height:80px;object-fit:contain;">`;
      html += `<div style="display:flex;align-items:center;gap:4px;margin-top:8px;">`;
      html += `<span style="color:#fff;font-size:16px;">${p.name}</span>`;
      html += `</div>`;
      html += `</div>`;
    });
    html += '</div>';
  });
  html += '</div>';
  
  html += '</div>';
  
  lobby.innerHTML = html;
  
  document.querySelectorAll('.loaded-char-box').forEach(box => {
    box.onclick = () => {
      if (box.classList.contains('selected')) return;
      
      const playerId = box.dataset.playerId;
      const playerName = box.dataset.playerName;
      const character = box.dataset.character;
      const variant = box.dataset.variant;
      
      box.classList.add('selected');
      box.style.borderColor = '#e94560';
      box.style.background = 'rgba(233,69,96,0.2)';
      
      loadedSelectedChars[playerId] = { name: playerName, character, variant };
      myId = playerId;
      localStorage.setItem('monopoly_player_name', playerName);
      localStorage.setItem('monopoly_player_character', character + variant);
      localStorage.setItem('monopoly_player_variant', variant);
      
      socket.emit('loadedGameSelectCharacter', { playerId, playerName, character, variant });
    };
  });
}

socket.on('loadedGameAllSelected', () => {
  isLoadedGame = false;
  pendingLoadRender = true;
  const lobby = $('lobby');
  const game = $('game');
  if (lobby) lobby.classList.add('hidden');
  if (game) game.classList.remove('hidden');
  if (settingsWrapper) settingsWrapper.classList.remove('hidden');
  if (emojiBtn) emojiBtn.classList.remove('hidden');
  if (testDiceBtn) testDiceBtn.classList.add('hidden');
  const disconnectBtn2 = $('disconnectBtn2');
  if (disconnectBtn2) disconnectBtn2.classList.remove('hidden');
  
  render();
  rebindAreaFButtons();
});

socket.on('requestFgReport', () => {
  const areaF = document.getElementById('areaF');
  const areaG = document.getElementById('areaG');
  socket.emit('fgReport', {
    areaF: areaF ? areaF.innerHTML : '',
    areaG: areaG ? areaG.innerHTML : ''
  });
});

socket.on('restoreAreaF', ({ html }) => {
  const areaF = document.getElementById('areaF');
  if (areaF && html) {
    areaF.innerHTML = html;
    rebindAreaFButtons();
  }
});

socket.on('restoreAreaG', ({ html }) => {
  const areaG = document.getElementById('areaG');
  if (areaG && html) areaG.innerHTML = html;
});

socket.on('loadedGameCharacterTaken', ({ playerId, playerName }) => {
  const boxes = document.querySelectorAll('.loaded-char-box');
  boxes.forEach(box => {
    if (box.dataset.playerId === playerId || box.dataset.playerName === playerName) {
      box.classList.add('selected');
      box.style.borderColor = '#e94560';
      box.style.background = 'rgba(233,69,96,0.2)';
      box.style.cursor = 'not-allowed';
      box.onclick = null;
    }
  });
});

socket.on('quickStartPlayer', ({ name, character, variant }) => {
  localStorage.setItem('monopoly_player_name', name);
  localStorage.setItem('monopoly_player_character', character + (variant || ''));
  localStorage.setItem('monopoly_player_variant', variant || '');
  selectedChar = character + (variant || '');
  selectedVariant = variant || '';
});

socket.on('voteUpdate', ({ type, voted, total }) => {
  if (type === 'restart') {
    restartBtn2.textContent = `已投票 ${voted}/${total}`;
  }
});

socket.on('serverRestarting', ({ clearLocalStorage }) => {
  console.log(`[客户端] 收到serverRestarting事件，clearLocalStorage: ${clearLocalStorage}`);
  serverRestarting = true;
  
  // 清除localStorage（除了保存的游戏数据）
  if (clearLocalStorage) {
    console.log(`[客户端] 清除localStorage（玩家信息）`);
    localStorage.removeItem('monopoly_player_name');
    localStorage.removeItem('monopoly_player_character');
    localStorage.removeItem('monopoly_player_variant');
    localStorage.removeItem('monopoly_has_joined');
    // 注意：不清除保存的游戏数据（如果有）
  }
  
  $('areaE').innerHTML = '服务器正在重新启动，请等待几秒...';
  fitAreaEText();
});

function rollRandomDice() {
  if (dicePickerVisible) hideDicePicker();
  const value = Math.floor(Math.random() * 6) + 1;
  waitingForTurnEnd = true;
  hasRolledThisTurn = true;
  updateGAreaDiceImage(value, true);
  socket.emit('rollDice', value);
}

function showDicePicker() {
  dicePickerVisible = true;
  ensureGAreaExists();
  
  // 创建骰子选择面板（九宫格：1-6, 30, 10, 0）
  let overlay = document.getElementById('dicePickerOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'dicePickerOverlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;';
    document.body.appendChild(overlay);
  }
  
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div style="color:#fff;font-size:clamp(12px,2vh,18px);margin-bottom:2vh;">选择骰子点数</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1vh;">
      <button class="dice-num-btn" onclick="selectDice(1)">1</button>
      <button class="dice-num-btn" onclick="selectDice(2)">2</button>
      <button class="dice-num-btn" onclick="selectDice(3)">3</button>
      <button class="dice-num-btn" onclick="selectDice(4)">4</button>
      <button class="dice-num-btn" onclick="selectDice(5)">5</button>
      <button class="dice-num-btn" onclick="selectDice(6)">6</button>
      <button class="dice-num-btn" onclick="selectDice(18)">18</button>
      <button class="dice-num-btn" onclick="selectDice(12)">12</button>
      <button class="dice-num-btn" onclick="selectDice(0)">0</button>
    </div>
    <button onclick="hideDicePicker()" style="margin-top:2vh;padding:1vh 3vh;font-size:clamp(10px,1.5vh,14px);cursor:pointer;background:#333;color:#fff;border:none;border-radius:8px;">取消</button>
  `;
}

function selectDice(value) {
  hideDicePicker();
  waitingForTurnEnd = true;
  hasRolledThisTurn = true;
  updateGAreaDiceImage(value, true);
  socket.emit('rollDice', value);
}

function ensureGAreaExists() {
  if (!$('areaG')) {
    // Ensure G area exists
    const areaG = document.createElement('div');
    areaG.id = 'areaG';
    const bottomBar = $('bottomBar');
    if (bottomBar) {
      bottomBar.insertBefore(areaG, $('areaF').nextSibling);
    }
  }
}

function updateGAreaDiceImage(diceValue, isMyTurn) {
  console.log('[DEBUG] updateGAreaDiceImage: diceValue=', diceValue, 'isMyTurn=', isMyTurn, 'keepGArea=', keepGArea);
  if (keepGArea) return;
  ensureGAreaExists();
  const areaG = $('areaG');
  if (!areaG) {
    return;
  }

  if (wenjigifwuDiceValues) {
    areaG.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;gap:4px;"><img src="/drawable/touzi/t${wenjigifwuDiceValues.dice1}.png" style="width:45%;height:auto;"><img src="/drawable/touzi/t${wenjigifwuDiceValues.dice2}.png" style="width:45%;height:auto;"></div>`;
    areaG.style.cursor = 'not-allowed';
    areaG.style.opacity = '0.6';
    areaG.onclick = null;
    return;
  }

  if (liebaoDiceValues) {
    areaG.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;gap:4px;"><img src="/drawable/touzi/t${liebaoDiceValues.dice1}.png" style="width:45%;height:auto;"><img src="/drawable/touzi/t${liebaoDiceValues.dice2}.png" style="width:45%;height:auto;"></div>`;
    areaG.style.cursor = 'not-allowed';
    areaG.style.opacity = '0.6';
    areaG.onclick = null;
    return;
  }

  if (colorDiceSumValues) {
    areaG.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;gap:4px;"><img src="/drawable/touzi/t${colorDiceSumValues.dice1}.png" style="width:45%;height:auto;"><img src="/drawable/touzi/t${colorDiceSumValues.dice2}.png" style="width:45%;height:auto;"></div>`;
    areaG.style.cursor = 'not-allowed';
    areaG.style.opacity = '0.6';
    areaG.onclick = null;
    return;
  }
  
  const cur = players[currentPlayerIdx];
  const hasWenjigifwu = cur?.wenjigifwu;
  const hasLiebao = cur?.liebao;
  const hasHanxueMa = cur?.hanxueMa;

  if (diceValue === 0) {
    if (isMyTurn && (hasWenjigifwu || hasLiebao)) {
      areaG.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;gap:4px;"><img src="/drawable/touzi/t0.png" style="width:45%;height:100%;object-fit:contain;"><img src="/drawable/touzi/t0.png" style="width:45%;height:100%;object-fit:contain;"></div>`;
      areaG.style.cursor = 'pointer';
      areaG.style.opacity = '1';
      areaG.onclick = () => {
        socket.emit('rollDice', 0);
      };
    } else if (isMyTurn && hasHanxueMa) {
      areaG.innerHTML = `<img src="/drawable/chongwu/11.png" style="width:100%;height:100%;object-fit:contain;">`;
      areaG.style.cursor = 'pointer';
      areaG.style.opacity = '1';
      areaG.onclick = () => {
        socket.emit('rollDice', 0);
      };
    } else if (isMyTurn) {
      areaG.innerHTML = `<img src="/drawable/touzi/t0.png" style="width:100%;height:100%;object-fit:contain;">`;
      areaG.style.cursor = 'pointer';
      areaG.style.opacity = '1';
      areaG.onclick = () => {
        if (!dicePickerVisible) rollRandomDice();
      };
    } else {
      areaG.innerHTML = '';
      areaG.style.cursor = 'default';
      areaG.style.opacity = '1';
      areaG.onclick = null;
    }
  } else if (diceValue >= 1 && diceValue <= 6) {
    areaG.innerHTML = `<img src="/drawable/touzi/t${diceValue}.png">`;
    areaG.style.cursor = 'not-allowed';
    areaG.style.opacity = '0.6';
    areaG.onclick = null;
  } else {
    areaG.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:bold;color:#fff;">${diceValue}</div>`;
    areaG.style.cursor = 'not-allowed';
    areaG.style.opacity = '0.6';
    areaG.onclick = null;
  }
  currentDiceValue = diceValue;
}

function hideDicePicker() {
  dicePickerVisible = false;
  const overlay = document.getElementById('dicePickerOverlay');
  if (overlay) overlay.style.display = 'none';
  
  // 如果还没有选择点数，恢复 G 区状态
  if (currentDiceValue === 0) {
    const areaG = $('areaG');
    if (areaG) {
      areaG.style.cursor = 'pointer';
      areaG.style.opacity = '1';
      areaG.onclick = () => {
        if (!dicePickerVisible) rollRandomDice();
      };
    }
  }
}

// rollBtn removed, dice functionality moved to G area
buyBtn.onclick = () => socket.emit('buyProperty');
skipBtn.onclick = () => socket.emit('skipBuy');

socket.on('join', ({ name, character }) => {
  
});

socket.on('error', msg => {
  console.error('Server error:', msg);
  const areaE = $('areaE');
  if (areaE) { areaE.innerHTML = msg; fitAreaEText(); }
});
socket.on('chance', msg => alert(msg));

let lastAreaEMessage = '';
let areaEHistoryMessages = []; // 存储E区历史消息，最多10条

function setAreaE(html) {
  const el = $('areaE');
  if (!el) return;
  el.innerHTML = html;
}

function setAreaEText(text) {
  const el = $('areaE');
  if (!el) return;
  el.textContent = text;
}

function fitAreaEText() {
  const el = $('areaE');
  if (!el) return;
  el.style.fontSize = '20px';
  el.style.lineHeight = '1.2';
  
  // 检测内容高度，决定是否居中
  requestAnimationFrame(() => {
    const scrollHeight = el.scrollHeight;
    const clientHeight = el.clientHeight;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const parent = el.parentElement;
    const pcs = parent ? getComputedStyle(parent) : null;
    const prect = parent ? parent.getBoundingClientRect() : null;
    if (scrollHeight <= clientHeight) {
      // 内容未超出，居中显示
      el.style.alignItems = 'center';
      el.scrollTop = 0;
    } else {
      // 内容超出，从顶部开始显示
      el.style.alignItems = 'flex-start';
    }
  });
}

function setupAreaEObserver() {
  const el = $('areaE');
  if (!el) return;
  const observer = new MutationObserver(() => {
    fitAreaEText();
  });
  observer.observe(el, { childList: true, characterData: true, subtree: true });
}

document.addEventListener('DOMContentLoaded', () => {
  socket.emit('inLobby');
  setupAreaEObserver();
  
  // E区拖动滚动功能
  const areaE = $('areaE');
  if (areaE) {
    let isDragging = false;
    let startY = 0;
    let scrollTop = 0;
    
    areaE.addEventListener('mousedown', (e) => {
      isDragging = true;
      startY = e.pageY;
      scrollTop = areaE.scrollTop;
      areaE.style.cursor = 'grabbing';
    });
    
    areaE.addEventListener('mouseleave', () => {
      isDragging = false;
      areaE.style.cursor = 'default';
    });
    
    areaE.addEventListener('mouseup', () => {
      isDragging = false;
      areaE.style.cursor = 'default';
    });
    
    areaE.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const y = e.pageY;
      const walk = startY - y;
      areaE.scrollTop = scrollTop + walk;
    });
    
    // 触摸事件支持
    areaE.addEventListener('touchstart', (e) => {
      isDragging = true;
      startY = e.touches[0].pageY;
      scrollTop = areaE.scrollTop;
    });
    
    areaE.addEventListener('touchend', () => {
      isDragging = false;
    });
    
    areaE.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      const y = e.touches[0].pageY;
      const walk = startY - y;
      areaE.scrollTop = scrollTop + walk;
    });
  }
});

function showCalculatorPanel(onConfirm, options = {}) {
  const boardEl = $('board');
  if (!boardEl) return;
  
  let panel = document.getElementById('calculatorPanel');
  if (panel) {
    panel.remove();
    return;
  }
  
  const me = players.find(p => p.id === myId);
  const maxMoney = me ? (me.money + (me.tempMoney || 0)) : 0;
  
  panel = document.createElement('div');
  panel.id = 'calculatorPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:110;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.95);pointer-events:auto;padding:clamp(8px,2vh,20px);overflow:hidden;';
  
  let currentValue = '0';
  const title = options.title || '';
  const showCloseBtn = options.showCloseBtn !== false;
  const image = options.image || '';
  
  const updateButtons = () => {
    const clearBtn = $('calcClearBtn');
    const confirmBtn = $('calcConfirmBtn');
    if (clearBtn && confirmBtn) {
      if (currentValue === '0') {
        clearBtn.disabled = true;
        clearBtn.style.color = 'transparent';
        confirmBtn.disabled = true;
        confirmBtn.style.color = 'transparent';
      } else {
        clearBtn.disabled = false;
        clearBtn.style.color = '#fff';
        confirmBtn.disabled = false;
        confirmBtn.style.color = '#fff';
      }
    }
  };
  
  let imageHtml = image ? `<img src="${image}" style="max-width:70%;max-height:18vh;width:auto;height:auto;margin-bottom:clamp(6px,1.5vh,20px);object-fit:contain;">` : '';
  let titleHtml = title ? `<div style="color:#fff;font-size:clamp(12px,2.5vh,20px);margin-bottom:clamp(6px,1.5vh,20px);text-align:center;line-height:1.3;padding:0 8px;">${title}</div>` : '';
  let closeBtnHtml = showCloseBtn ? `<div style="position:absolute;top:4px;right:4px;width:clamp(24px,4vh,36px);height:clamp(24px,4vh,36px);background:#e74c3c;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:clamp(14px,3vh,24px);font-weight:bold;line-height:1;" id="calcCloseBtn">×</div>` : '';
  
  panel.innerHTML = `
    ${closeBtnHtml}
    ${imageHtml}
    ${titleHtml}
    <div style="display:flex;align-items:center;gap:clamp(4px,1vw,10px);margin-bottom:clamp(6px,1.5vh,20px);flex-wrap:wrap;justify-content:center;">
      <input type="text" id="calcDisplay" value="0" readonly style="width:clamp(80px,20vw,160px);text-align:center;font-size:clamp(18px,4vh,32px);background:#fff;color:#000;border:1px solid #666;padding:clamp(4px,1vh,10px);border-radius:4px;font-weight:bold;">
      <button id="calcClearBtn" class="calc-btn" disabled style="color:transparent;">清零</button>
      <button id="calcConfirmBtn" class="calc-btn" disabled style="color:transparent;">确定</button>
    </div>
    <div style="display:flex;gap:clamp(4px,1vw,8px);margin-bottom:clamp(4px,1vh,8px);flex-wrap:wrap;justify-content:center;">
      <button class="calc-btn calc-num" data-num="0">0</button>
      <button class="calc-btn calc-num" data-num="1">1</button>
      <button class="calc-btn calc-num" data-num="2">2</button>
      <button class="calc-btn calc-num" data-num="3">3</button>
      <button class="calc-btn calc-num" data-num="4">4</button>
    </div>
    <div style="display:flex;gap:clamp(4px,1vw,8px);flex-wrap:wrap;justify-content:center;">
      <button class="calc-btn calc-num" data-num="5">5</button>
      <button class="calc-btn calc-num" data-num="6">6</button>
      <button class="calc-btn calc-num" data-num="7">7</button>
      <button class="calc-btn calc-num" data-num="8">8</button>
      <button class="calc-btn calc-num" data-num="9">9</button>
    </div>
  `;
  
  const style = document.createElement('style');
  style.textContent = `.calc-btn { min-width:clamp(36px,9vw,56px);height:clamp(36px,9vw,56px);background:#333;color:#fff;border:none;border-radius:clamp(4px,1vh,8px);font-size:clamp(14px,3.5vw,22px);cursor:pointer;padding:0 clamp(4px,1vw,12px);white-space:nowrap; } .calc-btn:hover { background:#555; } .calc-btn:disabled { background:#333 !important; color:transparent !important; opacity:1 !important; }`;
  panel.appendChild(style);
  
  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);
  
  const display = $('calcDisplay');
  const clearBtn = $('calcClearBtn');
  const confirmBtn = $('calcConfirmBtn');
  const closeBtn = $('calcCloseBtn');
  
  document.querySelectorAll('.calc-num').forEach(btn => {
    btn.onclick = () => {
      const num = btn.dataset.num;
      let newValue;
      if (currentValue === '0') {
        newValue = num;
      } else {
        newValue = currentValue + num;
      }
      // 检查最大值限制
      if (parseInt(newValue) > 999) {
        return;
      }
      currentValue = newValue;
      display.value = currentValue;
      updateButtons();
    };
  });
  
  clearBtn.onclick = () => {
    currentValue = '0';
    display.value = currentValue;
    updateButtons();
  };
  
  confirmBtn.onclick = () => {
    const value = parseInt(currentValue) || 0;
    panel.remove();
    if (onConfirm) onConfirm(value);
  };
  
  if (closeBtn) {
    closeBtn.onclick = () => {
      panel.remove();
    };
  }
}

function closeCalculatorPanel() {
  const panel = document.getElementById('calculatorPanel');
  if (panel) panel.remove();
}

function showAreaEHistoryPanel() {
  // 如果没有历史消息，不显示面板
  if (areaEHistoryMessages.length === 0) return;
  
  // 创建历史消息面板
  let panel = document.getElementById('areaEHistoryPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'areaEHistoryPanel';
    panel.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000;background:rgba(0,0,0,1);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding-top:5vh;';
    document.body.appendChild(panel);
  }
  
  panel.style.display = 'flex';
  
  // 构建历史消息内容（使用格子名字字体大小）
  let messagesHtml = areaEHistoryMessages.map(msg => 
    `<div style="width:90%;padding:1vh;margin:0.5vh 0;background:#1a2a4a;border-radius:8px;color:#fff;font-size:clamp(9px,1.75vh,14px);text-align:center;">${msg}</div>`
  ).join('');
  
  panel.innerHTML = `
    <div style="position:absolute;top:1vh;right:2vh;font-size:clamp(20px,3vh,30px);color:red;cursor:pointer;font-weight:bold;" onclick="closeAreaEHistoryPanel()">X</div>
    <div style="color:#fff;font-size:clamp(9px,1.75vh,14px);margin-bottom:2vh;">历史消息（最近10条）</div>
    <div style="width:100%;max-height:80vh;overflow-y:auto;display:flex;flex-direction:column;align-items:center;">
      ${messagesHtml}
    </div>
  `;
}

function closeAreaEHistoryPanel() {
  const panel = document.getElementById('areaEHistoryPanel');
  if (panel) panel.style.display = 'none';
}

socket.on('updateAreaE', ({ message }) => {
  if (message) {
    lastAreaEMessage = message;
    // 保存到历史消息（最多10条）
    areaEHistoryMessages.push(message);
    if (areaEHistoryMessages.length > 10) {
      areaEHistoryMessages.shift();
    }
    $('areaE').innerHTML = message;
    fitAreaEText();
  }
  showThinkingOnce = false;
});



socket.on('hideAllPanels', () => {
  // 清除所有面板
  ['kunlunPanel', 'qiyuPanel', 'sansiPanel', 'auctionPanel', 'fanzhuanPanel', 'dayunPanel', 'protectPanel', 'diamondPanel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
  // tckOverlay只清空内容，不删除元素
  const tckOverlay = document.getElementById('tckOverlay');
  if (tckOverlay) {
    tckOverlay.innerHTML = '';
    tckOverlay.style.display = 'none';
  }
  tckQueue.length = 0;
  // 清除bottomBar覆盖层（不清空原有内容）
  hideBottomBarOverlay();
});

function syncTckWidth() {
  // TCK现在在actionBar内，宽度自适应，无需手动设置
}

// 延迟修正tckOverlay高度：TCK现在在actionBar内，高度由内容决定
function fixTckOverlayHeight() {
}

window.addEventListener('resize', syncTckWidth);

// 消息队列：TIP和TCK分开管理
const tipQueue = [];
const tckQueue = [];
const MAX_TCK_QUEUE = 3;

function renderTipQueue() {
  const container = document.getElementById('tipOverlay');
  if (!container) return;
  container.innerHTML = '';
  for (let i = tipQueue.length - 1; i >= 0; i--) {
    container.appendChild(tipQueue[i].el);
  }
  if (tipQueue.length === 0) {
    container.style.display = 'none';
  } else {
    container.style.display = 'flex';
  }
}

function renderTckQueue() {
  const container = document.getElementById('tckOverlay');
  if (!container) return;
  container.innerHTML = '';
  syncTckWidth();
  for (let i = tckQueue.length - 1; i >= 0; i--) {
    container.appendChild(tckQueue[i].el);
  }
  if (tckQueue.length === 0) {
    container.style.display = 'none';
  } else {
    container.style.display = 'flex';
  }
  // TCK图片对齐bottomBar
  requestAnimationFrame(() => {
    const bottomBar = document.getElementById('bottomBar');
    if (!bottomBar) return;
    const barRect = bottomBar.getBoundingClientRect();
    const tckImgs = container.querySelectorAll('.tck-item > img');
    tckImgs.forEach(img => {
      img.style.bottom = (window.innerHeight - barRect.bottom) + 'px';
      img.style.height = barRect.height + 'px';
      img.style.left = barRect.left + 'px';
      img.style.width = barRect.width + 'px';
    });
  });
}

function dismissTip(id) {
  const idx = tipQueue.findIndex(m => m.id === id);
  if (idx !== -1) {
    tipQueue.splice(idx, 1);
    renderTipQueue();
  }
}

function dismissTck(id) {
  const idx = tckQueue.findIndex(m => m.id === id);
  if (idx !== -1) {
    tckQueue.splice(idx, 1);
    renderTckQueue();
  }
}

let msgIdCounter = 0;

function pushTipMsg(el, dismissOnClick) {
  const id = ++msgIdCounter;
  el.dataset.msgId = id;
  if (dismissOnClick !== false) {
    el.onclick = (e) => {
      e.stopPropagation();
      dismissTip(id);
    };
  }
  tipQueue.length = 0;
  tipQueue.push({ id, el });
  renderTipQueue();
}

function showTip(imgSrc, text) {
  const tip = document.createElement('div');
  tip.className = 'tip-item';
  let imgHtml = '';
  let textHtml = '';
  if (imgSrc) {
    imgHtml = `<img src="${imgSrc}">`;
  }
  if (text) {
    textHtml = `<div class="tip-text">${text}</div>`;
  }
  tip.innerHTML = imgHtml + textHtml;
  pushTipMsg(tip);
}

function addTip(html) {
  const tip = document.createElement('div');
  tip.className = 'tip-item';
  let imgHtml = '';
  let textHtml = '';
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  const imgs = tempDiv.querySelectorAll('img');
  if (imgs.length > 0) {
    imgs[0].removeAttribute('style');
    imgHtml = imgs[0].outerHTML;
    imgs[0].remove();
  }
  // 检查是否有大号emoji span（font-size大于14px的）
  const spans = tempDiv.querySelectorAll('span');
  for (const span of spans) {
    const fs = span.style.fontSize;
    if (fs && parseInt(fs) > 14) {
      imgHtml = span.outerHTML;
      span.remove();
      break;
    }
  }
  const remaining = tempDiv.innerHTML.trim();
  if (remaining) {
    textHtml = `<div class="tip-text">${remaining}</div>`;
  }
  tip.innerHTML = imgHtml + textHtml;
  pushTipMsg(tip);
}

function showTck(imageSrc, text, options) {
  const stip = document.createElement('div');
  stip.className = 'tck-item';
  let imgHtml = imageSrc ? `<img src="${imageSrc}">` : '';
  let optionsHtml = '';
  if (options && options.length > 0) {
    optionsHtml = '<div class="tck-options">';
    options.forEach((opt, idx) => {
      const dangerClass = opt.danger ? ' danger' : '';
      const disabledAttr = opt.disabled ? ' disabled' : '';
      const disabledStyle = opt.disabled ? ' style="opacity:0.5;cursor:not-allowed"' : '';
      optionsHtml += `<button class="tck-option-btn${dangerClass}" data-idx="${idx}"${disabledAttr}${disabledStyle}>${opt.label}</button>`;
    });
    optionsHtml += '</div>';
  }
  stip.innerHTML = `${imgHtml}<div class="tck-content"><div class="tck-text">${text}</div>${optionsHtml}</div>`;
  
  const id = ++msgIdCounter;
  stip.dataset.msgId = id;
  
  if (options && options.length > 0) {
    stip.querySelectorAll('.tck-option-btn:not([disabled])').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        if (options[idx] && options[idx].callback) options[idx].callback();
        dismissTck(id);
      };
    });
  } else {
    stip.onclick = (e) => {
      e.stopPropagation();
      dismissTck(id);
    };
  }
  
  tckQueue.unshift({ id, el: stip });
  while (tckQueue.length > MAX_TCK_QUEUE) {
    tckQueue.pop();
  }
  renderTckQueue();
  return stip;
}

function showBottomBarOverlay(imageSrc) {
  const bottomBar = $('bottomBar');
  if (!bottomBar) return;
  let overlay = document.getElementById('bottomBarOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'bottomBarOverlay';
    const barHeight = bottomBar.offsetHeight || 80;
    overlay.style.cssText = `position:absolute;top:0;left:0;width:100%;height:${barHeight}px;background:rgba(0,0,0,1);display:flex;align-items:center;justify-content:center;z-index:1000;overflow:hidden;`;
    bottomBar.style.position = 'relative';
    bottomBar.appendChild(overlay);
  }
  const imgHeight = Math.min(60, (overlay.offsetHeight || 80) - 20);
  overlay.innerHTML = `<div style="text-align:center;display:flex;align-items:center;gap:8px;"><img src="${imageSrc}" style="height:${imgHeight}px;width:auto;object-fit:contain;"></div>`;
}

function hideBottomBarOverlay() {
  const overlay = document.getElementById('bottomBarOverlay');
  if (overlay) overlay.remove();
}

socket.on('bAreaOverlay', ({ imageSrc }) => {
  showBottomBarOverlay(imageSrc);
});

socket.on('bAreaOverlayClose', () => {
  hideBottomBarOverlay();
});

function clearTips() {
  tipQueue.length = 0;
  const tipContainer = document.getElementById('tipOverlay');
  if (tipContainer) tipContainer.innerHTML = '';
  tckQueue.length = 0;
  const tckContainer = document.getElementById('tckOverlay');
  if (tckContainer) tckContainer.innerHTML = '';
  hideBottomBarOverlay();
}

function showPopupMessage(html) {
  addTip(html);
}

function clearPopupMessages() {
  clearTips();
}

socket.on('popupMessage', ({ message }) => {
  addTip(message);
});

socket.on('closeAllPanels', () => {
  // 关闭三思面板
  sansiPanelState = null;
  const sansiPanel = document.getElementById('sansiPanel');
  if (sansiPanel) sansiPanel.remove();
  document.querySelectorAll('.sansi-panel, .sansi-overlay').forEach(el => el.remove());
  // 关闭放逐面板
  const exilePanel = document.getElementById('exilePanel');
  if (exilePanel) exilePanel.remove();
  // 关闭五岳改造面板
  const wuyuePanel = document.getElementById('wuyueReformPanel');
  if (wuyuePanel) wuyuePanel.remove();
  // 关闭机场改造面板
  const airportPanel = document.getElementById('airportReformPanel');
  if (airportPanel) airportPanel.remove();
  // 关闭迷宫面板
  const mazePanel = document.getElementById('mazePanel');
  if (mazePanel) mazePanel.remove();
  // 关闭德州扑克面板
  const texasPanel = document.querySelector('.texas-panel');
  if (texasPanel) texasPanel.remove();
  // 关闭TCK
  clearTips();
  // F区显示结束按钮
  const cur = players[currentPlayerIdx];
  const isMyTurn = cur?.id === myId && !cur?.bankrupt;
  if (isMyTurn) {
    document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    const endTurnBtn = document.getElementById('endTurnBtn');
    if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
  }
});

socket.on('showTip', ({ imgSrc, text }) => {
  showTip(imgSrc, text);
});

socket.on('jidiChoose', ({ aliveIds, orderedIds, deadOrder, deadCauses }) => {
  const myId = socket.id;
  if (!aliveIds.includes(myId)) return;
  jidiAliveIds = aliveIds;
  const hArea = document.getElementById('hArea');
  if (!hArea) return;
  const existing = document.getElementById('jidiOverlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'jidiOverlay';
  overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;';
  const bg = document.createElement('img');
  bg.src = '/drawable/jiyu/jidiqiusheng/bj2.png';
  bg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;pointer-events:auto;';
  overlay.appendChild(bg);
  const wrapper = document.createElement('div');
  wrapper.id = 'jidiBtns';
  wrapper.style.cssText = 'position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px;width:100%;';
  const shootImg = document.createElement('img');
  shootImg.src = '/drawable/jiyu/jidiqiusheng/kaiqiang.png';
  shootImg.style.cssText = 'cursor:pointer;height:60px;pointer-events:auto;';
  const reboundImg = document.createElement('img');
  reboundImg.src = '/drawable/jiyu/jidiqiusheng/fantan.png';
  reboundImg.style.cssText = 'cursor:pointer;height:60px;pointer-events:auto;';
  const emptyImg = document.createElement('img');
  emptyImg.src = '/drawable/jiyu/jidiqiusheng/kongqiang.png';
  emptyImg.style.cssText = 'cursor:pointer;height:60px;pointer-events:auto;';
  wrapper.appendChild(shootImg);
  wrapper.appendChild(reboundImg);
  wrapper.appendChild(emptyImg);
  if (deadOrder && deadOrder.length > 0) {
    const deadDiv = document.createElement('div');
    deadDiv.id = 'jidiDeadOrder';
    deadDiv.style.cssText = 'position:relative;z-index:1;color:#fff;font-size:14px;margin-top:12px;text-align:center;';
    const deadNames = deadOrder.map(id => {
      const p = window.syncData && window.syncData.players && window.syncData.players.find(pp => pp.id === id);
      if (!p) return id;
      let cause = '';
      if (deadCauses && deadCauses[id]) {
        const c = deadCauses[id];
        if (c.type === 'rebound') {
          const byP = window.syncData && window.syncData.players && window.syncData.players.find(pp => pp.id === c.byId);
          cause = `（${byP ? byP.name : '?'}反弹）`;
        } else if (c.type === 'shot') {
          const byP = window.syncData && window.syncData.players && window.syncData.players.find(pp => pp.id === c.byId);
          cause = `（${byP ? byP.name : '?'}开枪）`;
        } else if (c.type === 'selfRebound') {
          cause = '（反弹自己）';
        }
      }
      return coloredName(p.name + cause, p.color);
    });
    deadDiv.innerHTML = '死亡顺序：' + deadNames.join('，');
    wrapper.appendChild(deadDiv);
  }
  overlay.appendChild(wrapper);
  hArea.appendChild(overlay);
  shootImg.addEventListener('click', () => {
    selectingJidiTarget = true;
    wrapper.style.display = 'none';
    refreshPlayerCards();
    checkNoValidTarget();
  });
  reboundImg.addEventListener('click', () => {
    socket.emit('jidiChoice', { action: 'rebound' });
    wrapper.style.display = 'none';
  });
  emptyImg.addEventListener('click', () => {
    socket.emit('jidiChoice', { action: 'empty' });
    wrapper.style.display = 'none';
  });
});

socket.on('jidiChoiceMade', ({ playerId }) => {
});

socket.on('jidiRoundEnd', ({ roundNum, deadThisRound, nextRound }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    const deadNames = deadThisRound.map(id => {
      const p = window.syncData && window.syncData.players && window.syncData.players.find(pp => pp.id === id);
      return p ? p.name : id;
    });
    areaE.innerHTML = `第${roundNum}轮结束 ${deadNames.length > 0 ? deadNames.join(',') + '淘汰' : '无人淘汰'} | 第${nextRound}轮开始`;
    fitAreaEText();
  }
  const overlay = document.getElementById('jidiOverlay');
  if (overlay) overlay.remove();
});

socket.on('jidiEnd', ({ resultMsg }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = resultMsg;
    fitAreaEText();
  }
  const jidiOverlay = document.getElementById('jidiOverlay');
  if (jidiOverlay) jidiOverlay.remove();
  const areaF = document.getElementById('areaF');
  if (areaF) areaF.innerHTML = '';
  const current = window.syncData && window.syncData.players && window.syncData.players[window.syncData.currentPlayerIndex];
  if (current && current.id === socket.id && areaF) {
    const btn = document.createElement('button');
    btn.id = 'endTurnBtn';
    btn.className = 'jail-btn';
    btn.textContent = '结束';
    btn.addEventListener('click', () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    });
    areaF.appendChild(btn);
  }
});

socket.on('chuangGuanStart', ({ playerId, bonus, successRate }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = `闯关：初始奖金${bonus}，成功率${successRate}/10，是否继续？`;
    fitAreaEText();
  }
  const areaF = document.getElementById('areaF');
  if (areaF) areaF.innerHTML = '';
  if (socket.id === playerId && areaF) {
    const contBtn = document.createElement('div');
    contBtn.style.cssText = 'color:#000;padding:10px 30px;background:#fff;border-radius:8px;cursor:pointer;font-size:20px;white-space:nowrap;';
    contBtn.textContent = '继续';
    contBtn.addEventListener('click', () => {
      socket.emit('chuangGuanContinue');
    });
    const collectBtn = document.createElement('div');
    collectBtn.style.cssText = 'color:#000;padding:10px 30px;background:#fff;border-radius:8px;cursor:pointer;font-size:20px;white-space:nowrap;';
    collectBtn.textContent = '收米';
    collectBtn.addEventListener('click', () => {
      socket.emit('chuangGuanCollect');
    });
    areaF.appendChild(contBtn);
    areaF.appendChild(collectBtn);
  }
});

socket.on('chuangGuanResult', ({ playerId, roll, bonus, successRate, failed }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    if (failed) {
      areaE.innerHTML = `判定${roll}，闯关失败，奖金归零`;
      const areaF = document.getElementById('areaF');
      if (areaF) areaF.innerHTML = '';
      if (socket.id === playerId && areaF) {
        const btn = document.createElement('button');
        btn.id = 'endTurnBtn';
        btn.className = 'jail-btn';
        btn.textContent = '结束';
        btn.addEventListener('click', () => {
          areaF.innerHTML = '';
          socket.emit('endTurn');
        });
        areaF.appendChild(btn);
      }
    } else {
      areaE.innerHTML = `判定${roll}，奖金${bonus}，成功率${successRate}/10，是否继续？`;
      const areaF = document.getElementById('areaF');
      if (areaF) areaF.innerHTML = '';
      if (socket.id === playerId && areaF) {
        const contBtn = document.createElement('div');
        contBtn.style.cssText = 'color:#000;padding:10px 30px;background:#fff;border-radius:8px;cursor:pointer;font-size:20px;white-space:nowrap;';
        contBtn.textContent = '继续';
        contBtn.addEventListener('click', () => {
          socket.emit('chuangGuanContinue');
        });
        const collectBtn = document.createElement('div');
        collectBtn.style.cssText = 'color:#000;padding:10px 30px;background:#fff;border-radius:8px;cursor:pointer;font-size:20px;white-space:nowrap;';
        collectBtn.textContent = '收米';
        collectBtn.addEventListener('click', () => {
          socket.emit('chuangGuanCollect');
        });
        areaF.appendChild(contBtn);
        areaF.appendChild(collectBtn);
      }
    }
    fitAreaEText();
  }
});

socket.on('chuangGuanCollect', ({ playerInfo, bonus }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = `${coloredName(playerInfo.name, playerInfo.color)}收获奖金${bonus}`;
    fitAreaEText();
  }
  const areaF = document.getElementById('areaF');
  if (areaF) areaF.innerHTML = '';
  if (socket.id === playerInfo.id && areaF) {
    const btn = document.createElement('button');
    btn.id = 'endTurnBtn';
    btn.className = 'jail-btn';
    btn.textContent = '结束';
    btn.addEventListener('click', () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    });
    areaF.appendChild(btn);
  }
});

socket.on('gaichaoStart', ({ playerId }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = '改朝换代：请选择一名玩家互换全部地产卡';
    fitAreaEText();
  }
  if (socket.id === playerId) {
    selectingGaichaoTarget = true;
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('gaichaoResult', ({ playerInfo, targetInfo }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = `${coloredName(playerInfo.name, playerInfo.color)}与${coloredName(targetInfo.name, targetInfo.color)}互换全部地产卡`;
    fitAreaEText();
  }
  selectingGaichaoTarget = false;
  refreshPlayerCards();
  const areaF = document.getElementById('areaF');
  if (areaF) areaF.innerHTML = '';
  if (socket.id === playerInfo.id && areaF) {
    const btn = document.createElement('button');
    btn.id = 'endTurnBtn';
    btn.className = 'jail-btn';
    btn.textContent = '结束';
    btn.addEventListener('click', () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    });
    areaF.appendChild(btn);
  }
});

socket.on('baijinStart', ({ playerId }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = '拜金主义：请选择一名玩家互换现金';
    fitAreaEText();
  }
  if (socket.id === playerId) {
    selectingBaijinTarget = true;
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('baijinResult', ({ playerInfo, targetInfo }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = `${coloredName(playerInfo.name, playerInfo.color)}与${coloredName(targetInfo.name, targetInfo.color)}互换现金`;
    fitAreaEText();
  }
  selectingBaijinTarget = false;
  refreshPlayerCards();
  const areaF = document.getElementById('areaF');
  if (areaF) areaF.innerHTML = '';
  if (socket.id === playerInfo.id && areaF) {
    const btn = document.createElement('button');
    btn.id = 'endTurnBtn';
    btn.className = 'jail-btn';
    btn.textContent = '结束';
    btn.addEventListener('click', () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    });
    areaF.appendChild(btn);
  }
});

socket.on('guashaStart', ({ playerId }) => {
  if (socket.id === playerId) {
    selectingGuashaTarget = true;
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('jiaoyiStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="jiaoyiBtn" class="jail-btn">交易</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('jiaoyiBtn').onclick = () => {
        areaF.innerHTML = '';
        selectingJiaoyiTarget = true;
        refreshPlayerCards();
        checkNoValidTarget();
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('jiaoyiSelectProps', ({ currentId, targetId, currentName, currentColor, targetName, targetColor }) => {
  selectingJiaoyiTarget = false;
  jiaoyiSelectingProp = true;
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = '交易：双方各选择一块地产互换';
    fitAreaEText();
  }
  document.querySelectorAll('.space').forEach(el => {
    const spaceId = parseInt(el.dataset.id);
    const space = board.find(s => s.id === spaceId);
    if (space && space.isProperty && space.owner === socket.id && (space.owner === currentId || space.owner === targetId)) {
      el.style.border = '2px solid #fff';
      el.style.cursor = 'pointer';
      el.onclick = () => {
        document.querySelectorAll('.space').forEach(sEl => {
          sEl.style.border = '';
          sEl.style.cursor = '';
          sEl.onclick = null;
        });
        el.style.border = '3px solid #f1c40f';
        socket.emit('jiaoyiPropSelected', { propId: spaceId, ownerId: space.owner });
      };
    }
  });
});

socket.on('jiaoyiEnd', () => {
  jiaoyiSelectingProp = false;
  document.querySelectorAll('.space').forEach(el => {
    el.style.border = '';
    el.style.cursor = '';
    el.onclick = null;
  });
});

socket.on('paozhuanStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="paozhuanBtn" class="jail-btn">引玉</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('paozhuanBtn').onclick = () => {
        areaF.innerHTML = '';
        const myProps = board.filter(s => s.isProperty && s.owner === socket.id);
        // 排除放逐区的玩家：inJail=true或position===1
        const othersWithProps = players.filter(p => 
          p.id !== socket.id && 
          !p.bankrupt && 
          !p.inJail && 
          p.position !== 1 && 
          board.some(s => s.isProperty && s.owner === p.id)
        );
        if (myProps.length === 0 || othersWithProps.length === 0) {
          const areaE = document.getElementById('areaE');
          if (areaE) {
            areaE.innerHTML = '没有合适的地产';
            fitAreaEText();
          }
          areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
          $('endTurnBtn').onclick = () => {
            areaF.innerHTML = '';
            socket.emit('endTurn');
          };
          return;
        }
        selectingPaozhuanTarget = true;
        refreshPlayerCards();
        checkNoValidTarget();
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('paozhuanSelectProps', ({ currentId, targetId, currentName, currentColor, targetName, targetColor }) => {
  selectingPaozhuanTarget = false;
  if (socket.id === currentId || socket.id === targetId) {
    paozhuanSelectingProp = true;
  }
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = '双方各选择一块地产互换';
    fitAreaEText();
  }
  render();
  document.querySelectorAll('.space').forEach(el => {
    const spaceId = parseInt(el.dataset.id);
    const space = board.find(s => s.id === spaceId);
    if (space && space.isProperty && (space.owner === currentId || space.owner === targetId) && space.owner === socket.id) {
      el.style.border = '2px solid #fff';
      el.style.cursor = 'pointer';
      el.onclick = (e) => {
        e.stopPropagation();
        el.style.border = '3px solid #f1c40f';
        el.style.cursor = '';
        el.onclick = null;
        socket.emit('paozhuanPropSelected', { propId: spaceId, ownerId: space.owner });
      };
    }
  });
});

socket.on('paozhuanPropUpdate', ({ currentPropId, targetPropId }) => {
  const myProps = board.filter(s => s.isProperty && s.owner === socket.id);
  const mySelectedPropId = myProps.find(p => p.id === currentPropId || p.id === targetPropId);
  if (mySelectedPropId) {
    const spaceEl = document.querySelector(`.space[data-id="${mySelectedPropId.id}"]`);
    if (spaceEl) {
      spaceEl.style.border = '3px solid #f1c40f';
    }
  }
});

socket.on('paozhuanEnd', () => {
  paozhuanSelectingProp = false;
  selectingPaozhuanTarget = false;
  document.querySelectorAll('.space').forEach(el => {
    el.style.border = '';
    el.style.cursor = '';
    el.onclick = null;
  });
  render();
});

socket.on('yuanjiaoStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="yuanjiaoBtn" class="jail-btn">远交近攻</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('yuanjiaoBtn').onclick = () => {
        areaF.innerHTML = '';
        // 排除放逐区的玩家：inJail=true或position===1
        const others = players.filter(p => p.id !== socket.id && !p.bankrupt && !p.inJail && p.position !== 1);
        if (others.length < 2) {
          const areaE = document.getElementById('areaE');
          if (areaE) {
            areaE.innerHTML = '目标不够';
            fitAreaEText();
          }
          areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
          $('endTurnBtn').onclick = () => {
            areaF.innerHTML = '';
            socket.emit('endTurn');
          };
          return;
        }
        selectingYuanjiaoTargetA = true;
        const areaE = document.getElementById('areaE');
        if (areaE) {
          areaE.innerHTML = '请选择远交的目标';
          fitAreaEText();
        }
        refreshPlayerCards();
        checkNoValidTarget();
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('yuanjiaoSelectTargetBStart', ({ playerId, excludeId }) => {
  if (socket.id === playerId) {
    selectingYuanjiaoTargetA = false;
    selectingYuanjiaoTargetB = true;
    yuanjiaoTargetAId = excludeId;
    const areaE = document.getElementById('areaE');
    if (areaE) {
      areaE.innerHTML = '请选择近攻的目标';
      fitAreaEText();
    }
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('shunyiStart', ({ playerId }) => {
  console.log(`[客户端瞬移] 收到shunyiStart事件, playerId: ${playerId}, socket.id: ${socket.id}`);
  if (socket.id === playerId) {
    console.log(`[客户端瞬移] 是我的回合，显示瞬移按钮`);
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="shunyiBtn" class="jail-btn">瞬移</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('shunyiBtn').onclick = () => {
        console.log(`[客户端瞬移] 点击瞬移按钮`);
        areaF.innerHTML = '';
        console.log(`[客户端瞬移] 检查其他玩家`);
        console.log(`[客户端瞬移] players数组: ${players.length}个玩家`);
        players.forEach(p => {
          const inExile = p.inJail || p.position === 1;
          console.log(`  - ${p.name}: id=${p.id}, bankrupt=${p.bankrupt}, inJail=${p.inJail}, position=${p.position}, inExile=${inExile}`);
        });
        // 排除自己、破产玩家和在放逐区的玩家（监狱、医院、海南）
        // inJail=true表示在虚拟监狱格子37/38/39
        // position===1表示在棋盘监狱格子（财产罪）
        const others = players.filter(p => p.id !== playerId && !p.bankrupt && !p.inJail && p.position !== 1);
        console.log(`[客户端瞬移] 筛选条件: id !== ${playerId} && !bankrupt && !inJail && position !== 1`);
        console.log(`[客户端瞬移] 其他玩家数量: ${others.length}`);
        others.forEach(p => {
          console.log(`  - ${p.name} (位置: ${p.position})`);
        });
        if (others.length === 0) {
          console.log(`[客户端瞬移] 没有其他玩家，显示"无人可飞"并结束`);
          const areaE = document.getElementById('areaE');
          if (areaE) {
            areaE.innerHTML = '无人可飞';
            fitAreaEText();
          }
          areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
          $('endTurnBtn').onclick = () => {
            areaF.innerHTML = '';
            socket.emit('endTurn');
          };
          return;
        }
        console.log(`[客户端瞬移] 有其他玩家，开始设置白框可点击`);
        selectingShunyiTarget = true;
        render();
        const positions = [...new Set(others.map(p => p.position))];
        console.log(`[客户端瞬移] 其他玩家位置: ${positions.join(', ')}`);
        let whiteBorderCount = 0;
        positions.forEach(posId => {
          const spaceEl = document.querySelector(`.space[data-id="${posId}"]`);
          if (spaceEl) {
            console.log(`[客户端瞬移] ✓ 位置${posId}设置白框可点击`);
            spaceEl.style.border = '2px solid #fff';
            spaceEl.style.cursor = 'pointer';
            whiteBorderCount++;
            spaceEl.onclick = (e) => {
              console.log(`[客户端瞬移] 点击位置${posId}, 发送shunyiSelectPos`);
              e.stopPropagation();
              selectingShunyiTarget = false;
              document.querySelectorAll('.space').forEach(sEl => {
                sEl.style.border = '';
                sEl.style.cursor = '';
                sEl.onclick = null;
              });
              socket.emit('shunyiSelectPos', { posId });
            };
          } else {
            console.log(`[客户端瞬移] ✗ 位置${posId}的元素不存在`);
          }
        });
        console.log(`[客户端瞬移] 设置了${whiteBorderCount}个白框可点击位置`);
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('shunyiEnd', () => {
  selectingShunyiTarget = false;
  document.querySelectorAll('.space').forEach(el => {
    el.style.border = '';
    el.style.cursor = '';
    el.onclick = null;
  });
  render();
});

socket.on('zhilijiemuStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="zhilijiemuBtn" class="jail-btn">智力</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('zhilijiemuBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('zhilijiemuStartQuiz');
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('zhongjinStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="zhongjinBtn" class="jail-btn">求宠</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('zhongjinBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('zhongjinGetPets');
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('zhongjinShowPets', ({ pets }) => {
  const boardEl = $('board');
  if (!boardEl) return;

  const panel = document.createElement('div');
  panel.id = 'zhongjinPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;display:flex;align-items:center;justify-content:center;gap:10px;background:rgba(0,0,0,0.8);';

  pets.forEach(pet => {
    const petDiv = document.createElement('div');
    petDiv.style.cssText = 'cursor:pointer;border:3px solid #fff;border-radius:8px;overflow:hidden;text-align:center;background:#222;width:50%;height:80%;display:flex;flex-direction:column;';
    const petImage = pet.image || pet;
    const petName = pet.name || '宠物';
    const petDesc = pet.desc || '';
    const isCwqPet = petImage.startsWith('cw');
    const petSrc = isCwqPet ? `/drawable/chongwu/chongwu2/${petImage}` : `/drawable/chongwu/${petImage}`;
    petDiv.innerHTML = `
      <img src="${petSrc}" style="width:100%;height:70%;object-fit:contain;display:block;">
      <div style="color:#fff;padding:8px;font-size:14px;height:30%;display:flex;flex-direction:column;justify-content:center;">
        <div style="font-weight:bold;margin-bottom:4px;">${petName}</div>
        <div style="font-size:12px;word-break:break-all;">${petDesc}</div>
      </div>
    `;
    petDiv.onclick = () => {
      panel.remove();
      socket.emit('zhongjinSelectPet', { petName: petImage });
    };
    panel.appendChild(petDiv);
  });

  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);
});

socket.on('zhongjinEnd', () => {
  const panel = $('zhongjinPanel');
  if (panel) panel.remove();
});

socket.on('wanrenmiStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="wanrenmiBtn" class="jail-btn">万人迷</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('wanrenmiBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('wanrenmiExecute');
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('tongbuStart', ({ playerId, diceValue }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="tongbuBtn" class="jail-btn">同步</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('tongbuBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('tongbuExecute');
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('tongbuApplied', ({ playerId, playerName, playerColor, diceValue }) => {
  render();
});

let selectingXianhaiTarget = false;
let selectingShuimianTarget = false;
let shuimianCanSelf = false;
let selectingChehuoPos = false;

socket.on('xianhaiStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '';
      selectingXianhaiTarget = true;
      refreshPlayerCards();
      checkNoValidTarget();
    }
  }
});

socket.on('xianhaiSelectTarget', ({ canSelectSelf }) => {
  selectingXianhaiTarget = true;
  refreshPlayerCards();
});

socket.on('shuimianSelectTarget', ({ canSelectSelf }) => {
  selectingShuimianTarget = true;
  shuimianCanSelf = canSelectSelf;
  refreshPlayerCards();
});

socket.on('chehuoStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '';
      selectingChehuoPos = true;
      render();
      document.querySelectorAll('.space').forEach(el => {
        el.style.border = '2px solid #fff';
        el.style.cursor = 'pointer';
        el.onclick = (e) => {
          e.stopPropagation();
          const posId = parseInt(el.dataset.id);
          selectingChehuoPos = false;
          document.querySelectorAll('.space').forEach(sEl => {
            sEl.style.border = '';
            sEl.style.cursor = '';
            sEl.onclick = null;
          });
          render();
          socket.emit('chehuoSelectPos', { posId });
        };
      });
    }
  }
});

socket.on('zemuerqiStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="zemuerqiBtn" class="jail-btn">择木</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('zemuerqiBtn').onclick = () => {
        areaF.innerHTML = '';
        selectingZemuerqiTarget = true;
        refreshPlayerCards();
        checkNoValidTarget();
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('zibaoStart', ({ playerId, playerName, playerColor }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = '自爆卡车：所有人各选择一块地产失去';
    fitAreaEText();
  }
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="zibaoBtn" class="jail-btn">自爆</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('zibaoBtn').onclick = () => {
        areaF.innerHTML = '';
        const myProps = board.filter(s => s.isProperty && s.owner === socket.id);
        if (myProps.length === 0) {
          if (areaE) {
            areaE.innerHTML = '自爆卡车：没有地产可自爆';
            fitAreaEText();
          }
          socket.emit('showEndTurn');
          return;
        }
        socket.emit('zibaoTriggered');
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('zibaoSelectPropStart', () => {
  zibaoSelectingProp = true;
  const myProps = board.filter(s => s.isProperty && s.owner === socket.id);
  if (myProps.length > 0) {
    document.querySelectorAll('.space').forEach(el => {
      const spaceId = parseInt(el.dataset.id);
      const space = board.find(s => s.id === spaceId);
      if (space && space.isProperty && space.owner === socket.id) {
        el.style.border = '2px solid #fff';
        el.style.cursor = 'pointer';
        el.onclick = () => {
          document.querySelectorAll('.space').forEach(sEl => {
            sEl.style.border = '';
            sEl.style.cursor = '';
            sEl.onclick = null;
          });
          el.style.border = '3px solid #f1c40f';
          zibaoSelectingProp = false;
          socket.emit('zibaoSelectProp', { propId: spaceId });
        };
      }
    });
  }
});

socket.on('zibaoPropSelected', ({ playerId, propId }) => {
  if (socket.id === playerId) {
    zibaoSelectingProp = false;
  }
});

socket.on('zibaoEnd', () => {
  document.querySelectorAll('.space').forEach(el => {
    el.style.border = '';
    el.style.cursor = '';
    el.onclick = null;
  });
});

socket.on('jihuiStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="jihui7Btn" class="jail-btn">7</button><button id="jihuiRandomBtn" class="jail-btn">随机</button>';
      $('jihui7Btn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('jihuiChoice', { choice: '7' });
      };
      $('jihuiRandomBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('jihuiChoice', { choice: 'random' });
      };
    }
  }
});

socket.on('nantiStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="nanti7Btn" class="jail-btn">-7</button><button id="nantiRandomBtn" class="jail-btn">-随机</button>';
      $('nanti7Btn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('nantiChoice', { choice: '7' });
      };
      $('nantiRandomBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('nantiChoice', { choice: 'random' });
      };
    }
  }
});

socket.on('shuiguojiStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="shuiguojiBtn" class="jail-btn">水果机</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('shuiguojiBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('shuiguojiPlay');
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('shuiguojiResult', ({ playerId, dice1, dice2, dice3, amount }) => {
  const boardEl = $('board');
  if (!boardEl) return;
  
  let panel = document.getElementById('shuiguojiPanel');
  if (panel) panel.remove();
  
  panel = document.createElement('div');
  panel.id = 'shuiguojiPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:110;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.95);pointer-events:auto;padding:20px;';
  
  const isMyTurn = playerId === myId;
  const player = players.find(p => p.id === playerId);
  
  let closeBtnHtml = '';
  if (isMyTurn) {
    closeBtnHtml = `<div style="position:absolute;top:8px;right:8px;width:32px;height:32px;background:#e74c3c;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:20px;font-weight:bold;line-height:1;" id="shuiguojiCloseBtn">×</div>`;
  }
  
  panel.innerHTML = `
    ${closeBtnHtml}
    <img src="/drawable/jiyu/shuiguoji.jpg" style="width:150px;height:auto;margin-bottom:20px;">
    <div style="display:flex;gap:20px;">
      <video src="/drawable/touzi/tz${dice1}.mp4" autoplay muted playsinline style="width:80px;height:80px;object-fit:contain;"></video>
      <video src="/drawable/touzi/tz${dice2}.mp4" autoplay muted playsinline style="width:80px;height:80px;object-fit:contain;"></video>
      <video src="/drawable/touzi/tz${dice3}.mp4" autoplay muted playsinline style="width:80px;height:80px;object-fit:contain;"></video>
    </div>
  `;
  
  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);
  
  if (isMyTurn) {
    const closeBtn = $('shuiguojiCloseBtn');
    if (closeBtn) {
      closeBtn.onclick = () => {
        socket.emit('shuiguojiClose');
      };
    }
  }
});

socket.on('shuiguojiPanelClose', () => {
  const panel = document.getElementById('shuiguojiPanel');
  if (panel) panel.remove();
});

socket.on('xitieshiStart', ({ playerId, currentPos }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="xitieshiBtn" class="jail-btn">吸铁石</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('xitieshiBtn').onclick = () => {
        areaF.innerHTML = '';
        const others = players.filter(p => p.id !== socket.id && !p.bankrupt);
        if (others.length === 0) {
          const areaE = document.getElementById('areaE');
          if (areaE) {
            areaE.innerHTML = '没有合适的目标';
            fitAreaEText();
          }
          socket.emit('showEndTurn');
          return;
        }
        window.selectingXitieshiTarget = true;
        renderBoardOnly();
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('lijianStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="lijianBtn" class="jail-btn">离间</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('lijianBtn').onclick = () => {
        areaF.innerHTML = '';
        const validPlayers = players.filter(p => !p.bankrupt);
        if (validPlayers.length < 2) {
          const areaE = document.getElementById('areaE');
          if (areaE) {
            areaE.innerHTML = '没有合适的目标';
            fitAreaEText();
          }
          areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
          $('endTurnBtn').onclick = () => { areaF.innerHTML = ''; socket.emit('endTurn'); };
          return;
        }
        window.selectingLijianTarget = true;
        window.lijianFirstTarget = null;
        renderBoardOnly();
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('lijianSelectSecond', ({ playerId, firstTargetId }) => {
  window.lijianFirstTarget = firstTargetId;
  renderBoardOnly();
});

socket.on('lijianDuelStart', ({ playerId, targetAId, targetBId, eMsg }) => {
  window.selectingLijianTarget = false;
  window.lijianFirstTarget = null;
  refreshPlayerCards();
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = eMsg;
    fitAreaEText();
  }
  if (socket.id === targetAId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="lijian1Btn" class="jail-btn">-1</button><button id="lijian10Btn" class="jail-btn">-10</button>';
      $('lijian1Btn').onclick = () => { areaF.innerHTML = ''; socket.emit('lijianChoice', { choice: '-1' }); };
      $('lijian10Btn').onclick = () => { areaF.innerHTML = ''; socket.emit('lijianChoice', { choice: '-10' }); };
    }
  }
});

socket.on('lijianDuelContinue', ({ playerId, nextTurnId, eMsg }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = eMsg;
    fitAreaEText();
  }
  if (socket.id === nextTurnId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="lijian1Btn" class="jail-btn">-1</button><button id="lijian10Btn" class="jail-btn">-10</button>';
      $('lijian1Btn').onclick = () => { areaF.innerHTML = ''; socket.emit('lijianChoice', { choice: '-1' }); };
      $('lijian10Btn').onclick = () => { areaF.innerHTML = ''; socket.emit('lijianChoice', { choice: '-10' }); };
    }
  }
});

socket.on('lijianDuelEnd', ({ playerId, eMsg }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = eMsg;
    fitAreaEText();
  }
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
      $('endTurnBtn').onclick = () => { areaF.innerHTML = ''; socket.emit('endTurn'); };
    }
  }
});

socket.on('wuzhongshengyouStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="wuzhongshengyouBtn" class="jail-btn">无中生有</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('wuzhongshengyouBtn').onclick = () => {
        areaF.innerHTML = '';
        const myProps = board.filter(s => s.isProperty && s.owner === socket.id);
        const bankEmptyProps = board.filter(s => s.isProperty && !s.owner);
        if (myProps.length === 0 || bankEmptyProps.length === 0) {
          const areaE = document.getElementById('areaE');
          if (areaE) {
            areaE.innerHTML = '没有合适的地产';
            fitAreaEText();
          }
          areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
          $('endTurnBtn').onclick = () => { areaF.innerHTML = ''; socket.emit('endTurn'); };
          return;
        }
        window.selectingWuzhongshengyouProp = true;
        renderBoardOnly();
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('gongchengStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="gongchengBtn" class="jail-btn">攻城</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('gongchengBtn').onclick = () => {
        areaF.innerHTML = '';
        const propsWithHouse = board.filter(s => s.isProperty && s.owner !== socket.id && s.houseLevel > 0);
        if (propsWithHouse.length === 0) {
          const areaE = document.getElementById('areaE');
          if (areaE) {
            areaE.innerHTML = '没有合适的地产';
            fitAreaEText();
          }
          areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
          $('endTurnBtn').onclick = () => { areaF.innerHTML = ''; socket.emit('endTurn'); };
          return;
        }
        window.selectingGongchengProp = true;
        renderBoardOnly();
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('gongchengShowPanel', ({ targetId, propId, propName, attackerName, attackerColor }) => {
  if (socket.id === targetId) {
    const title = `${attackerName}令你展示金钱，花展示钱令${propName}降级/令你失去展示钱的一半`;
    showCalculatorPanel((amount) => {
      socket.emit('gongchengShowMoney', { amount });
    }, { title, showCloseBtn: false, image: '/drawable/jiyu/gongcheng.jpg' });
  }
});

socket.on('gongchengAttackerChoose', ({ playerId, targetId, showAmount, halfAmount, propName }) => {
  if (socket.id === playerId) {
    const areaE = document.getElementById('areaE');
    if (areaE) {
      areaE.innerHTML = `${players.find(p => p.id === targetId)?.name || '目标'}展示的金钱为${showAmount}，是否花${showAmount}令${propName}降级/令其-${halfAmount}`;
      fitAreaEText();
    }
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = `<button id="gongchengDowngradeBtn" class="jail-btn">降级</button><button id="gongchengHalfBtn" class="jail-btn">令其-${halfAmount}</button>`;
      $('gongchengDowngradeBtn').onclick = () => { areaF.innerHTML = ''; socket.emit('gongchengChoice', { choice: 'downgrade' }); };
      $('gongchengHalfBtn').onclick = () => { areaF.innerHTML = ''; socket.emit('gongchengChoice', { choice: 'half' }); };
    }
  }
});

socket.on('shenbingStart', ({ playerId, currentPos }) => {
  console.log(`[客户端神兵天降] 收到shenbingStart事件, playerId: ${playerId}, currentPos: ${currentPos}`);
  if (socket.id === playerId) {
    console.log(`[客户端神兵天降] 是我的回合，显示天降按钮`);
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="shenbingBtn" class="jail-btn">天降</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('shenbingBtn').onclick = () => {
        console.log(`[客户端神兵天降] 点击天降按钮`);
        areaF.innerHTML = '';
        console.log(`[客户端神兵天降] 检查6格范围内的其他玩家`);
        console.log(`[客户端神兵天降] 当前位置: ${currentPos}`);
        
        const nearbyPositions = [];
        for (let i = 1; i <= 6; i++) {
          nearbyPositions.push((currentPos + i) % 36);
          nearbyPositions.push((currentPos - i + 36) % 36);
        }
        console.log(`[客户端神兵天降] 6格范围内位置: ${nearbyPositions.join(', ')}`);
        
        // 排除放逐区的玩家：inJail=true（虚拟监狱37/38/39）或 position===1（棋盘监狱）
        const nearbyOthers = players.filter(p => 
          p.id !== socket.id && 
          !p.bankrupt && 
          !p.inJail && 
          p.position !== 1 && 
          nearbyPositions.includes(p.position)
        );
        console.log(`[客户端神兵天降] 6格范围内的其他玩家数量: ${nearbyOthers.length}`);
        nearbyOthers.forEach(p => {
          console.log(`  - ${p.name} (位置: ${p.position})`);
        });
        
        if (nearbyOthers.length === 0) {
          const areaE = document.getElementById('areaE');
          if (areaE) {
            areaE.innerHTML = '没有天降目标';
            fitAreaEText();
          }
          const areaF = document.getElementById('areaF');
          if (areaF) {
            areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
            $('endTurnBtn').onclick = () => {
              areaF.innerHTML = '';
              socket.emit('endTurn');
            };
          }
          return;
        }
        shenbingSelectingTarget = true;
        const targetPositions = new Set(nearbyOthers.map(p => p.position));
        document.querySelectorAll('.space').forEach(el => {
          const spaceId = parseInt(el.dataset.id);
          if (targetPositions.has(spaceId)) {
            el.style.border = '2px solid #fff';
            el.style.cursor = 'pointer';
            el.onclick = () => {
              document.querySelectorAll('.space').forEach(sEl => {
                sEl.style.border = '';
                sEl.style.cursor = '';
                sEl.onclick = null;
              });
              shenbingSelectingTarget = false;
              socket.emit('shenbingSelectTarget', { targetPos: spaceId });
            };
          }
        });
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

let banjiaSelectingSource = false;
let banjiaSelectingTarget = false;
let hunshuiSelectingTarget = false;

socket.on('banjiaStart', ({ playerId, step }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="banjiaBtn" class="jail-btn">搬家</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('banjiaBtn').onclick = () => {
        areaF.innerHTML = '';
        const myPropsWithHouse = board.filter(s => s.isProperty && s.owner === socket.id && s.houseLevel > 0);
        const myPropsCount = board.filter(s => s.isProperty && s.owner === socket.id).length;
        if (myPropsWithHouse.length === 0) {
          const areaE = document.getElementById('areaE');
          if (areaE) {
            areaE.innerHTML = '搬家：没有房屋';
            fitAreaEText();
          }
          socket.emit('showEndTurn');
          return;
        }
        if (myPropsCount < 2) {
          const areaE = document.getElementById('areaE');
          if (areaE) {
            areaE.innerHTML = '搬家：没有搬家目的地';
            fitAreaEText();
          }
          socket.emit('showEndTurn');
          return;
        }
        const areaE = document.getElementById('areaE');
        if (areaE) {
          areaE.innerHTML = '搬家：请选择搬走的房屋';
          fitAreaEText();
        }
        banjiaSelectingSource = true;
        document.querySelectorAll('.space').forEach(el => {
          const spaceId = parseInt(el.dataset.id);
          const space = board.find(s => s.id === spaceId);
          if (space && space.isProperty && space.owner === socket.id && space.houseLevel > 0) {
            el.style.border = '2px solid #fff';
            el.style.cursor = 'pointer';
            el.onclick = () => {
              document.querySelectorAll('.space').forEach(sEl => {
                sEl.style.border = '';
                sEl.style.cursor = '';
                sEl.onclick = null;
              });
              el.style.border = '3px solid #f1c40f';
              banjiaSelectingSource = false;
              socket.emit('banjiaSelectSource', { propId: spaceId });
            };
          }
        });
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('banjiaSelectTarget', ({ playerId, sourcePropId }) => {
  if (socket.id === playerId) {
    const areaE = document.getElementById('areaE');
    if (areaE) {
      areaE.innerHTML = '搬家：请选择搬家目的地';
      fitAreaEText();
    }
    banjiaSelectingTarget = true;
    document.querySelectorAll('.space').forEach(el => {
      const spaceId = parseInt(el.dataset.id);
      const space = board.find(s => s.id === spaceId);
      if (space && space.isProperty && space.owner === socket.id && spaceId !== sourcePropId) {
        el.style.border = '2px solid #fff';
        el.style.cursor = 'pointer';
        el.onclick = () => {
          document.querySelectorAll('.space').forEach(sEl => {
            sEl.style.border = '';
            sEl.style.cursor = '';
            sEl.onclick = null;
          });
          el.style.border = '3px solid #f1c40f';
          banjiaSelectingTarget = false;
          socket.emit('banjiaSelectTargetProp', { propId: spaceId });
        };
      }
    });
  }
});

socket.on('banjiaEnd', () => {
  document.querySelectorAll('.space').forEach(el => {
    el.style.border = '';
    el.style.cursor = '';
    el.onclick = null;
  });
});

socket.on('hunshuiStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="hunshuiBtn" class="jail-btn">摸鱼</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('hunshuiBtn').onclick = () => {
        areaF.innerHTML = '';
        const othersWithCards = players.filter(p => p.id !== socket.id && !p.bankrupt && p.cards && p.cards.length > 0);
        if (othersWithCards.length === 0) {
          const areaE = document.getElementById('areaE');
          if (areaE) {
            areaE.innerHTML = '混水摸鱼：没有合适的目标';
            fitAreaEText();
          }
          socket.emit('showEndTurn');
          return;
        }
        hunshuiSelectingTarget = true;
        refreshPlayerCards();
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

let lianheSelectingTarget = false;
let dacaoSelectingProp = false;

socket.on('lianheStart', ({ playerId }) => {
  if (socket.id === playerId) {
    lianheSelectingTarget = true;
    refreshPlayerCards();
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        lianheSelectingTarget = false;
        refreshPlayerCards();
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('dacaoStart', ({ playerId, playerName, playerColor }) => {
  const othersWithProperty = players.filter(p => p.id !== playerId && !p.bankrupt && board.some(s => s.isProperty && s.owner === p.id));
  if (socket.id !== playerId && othersWithProperty.some(p => p.id === socket.id)) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = `<button id="dacaoGiveBtn" class="jail-btn">给${playerName}7</button><button id="dacaoNotGiveBtn" class="jail-btn">不给</button>`;
      $('dacaoGiveBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('dacaoGive');
      };
      $('dacaoNotGiveBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('dacaoNotGive');
      };
    }
  } else if (socket.id === playerId) {
    dacaoSelectingProp = true;
    document.querySelectorAll('.space').forEach(el => {
      const spaceId = parseInt(el.dataset.id);
      const space = board.find(s => s.id === spaceId);
      if (space && space.isProperty && space.owner && space.owner !== socket.id) {
        el.style.border = '2px solid #fff';
        el.style.cursor = 'pointer';
        el.onclick = () => {
          document.querySelectorAll('.space').forEach(sEl => {
            sEl.style.border = '';
            sEl.style.cursor = '';
            sEl.onclick = null;
          });
          el.style.border = '3px solid #f1c40f';
          dacaoSelectingProp = false;
          socket.emit('dacaoSelectProp', { propId: spaceId });
        };
      }
    });
  }
});

socket.on('dacaoPropSelected', ({ propId }) => {
  document.querySelectorAll('.space').forEach(el => {
    el.style.border = '';
    el.style.cursor = '';
    el.onclick = null;
  });
});

socket.on('clearAreaF', () => {
  const areaF = document.getElementById('areaF');
  if (areaF) areaF.innerHTML = '';
});

socket.on('haiziStart', ({ playerId }) => {
  const areaF = document.getElementById('areaF');
  if (areaF) {
    areaF.innerHTML = '<button id="haiziMinusBtn" class="jail-btn">-10</button><button id="haiziPlusBtn" class="jail-btn">+4</button>';
    $('haiziMinusBtn').onclick = () => {
      areaF.innerHTML = '';
      socket.emit('haiziChoice', { choice: '-10' });
    };
    $('haiziPlusBtn').onclick = () => {
      areaF.innerHTML = '';
      socket.emit('haiziChoice', { choice: '+4' });
    };
  }
});

let erenSelectingTarget = false;
let qiangmaiSelectingProp = false;
let diaohuSelectingTarget = false;

socket.on('erenStart', ({ playerId }) => {
  if (socket.id === playerId) {
    erenSelectingTarget = true;
    refreshPlayerCards();
  }
});

socket.on('qiangmaiStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="qiangmaiBtn" class="jail-btn">强买</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('qiangmaiBtn').onclick = () => {
        areaF.innerHTML = '';
        const othersEmptyProps = board.filter(s => s.isProperty && s.owner && s.owner !== socket.id && s.houseLevel === 0);
        if (othersEmptyProps.length === 0) {
          const areaE = document.getElementById('areaE');
          if (areaE) {
            areaE.innerHTML = '没有合适的地产';
            fitAreaEText();
          }
          areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
          $('endTurnBtn').onclick = () => {
            areaF.innerHTML = '';
            socket.emit('endTurn');
          };
          return;
        }
        qiangmaiSelectingProp = true;
        document.querySelectorAll('.space').forEach(el => {
          const spaceId = parseInt(el.dataset.id);
          const space = board.find(s => s.id === spaceId);
          if (space && space.isProperty && space.owner && space.owner !== socket.id && space.houseLevel === 0) {
            el.style.border = '2px solid #fff';
            el.style.cursor = 'pointer';
            el.onclick = () => {
              document.querySelectorAll('.space').forEach(sEl => {
                sEl.style.border = '';
                sEl.style.cursor = '';
                sEl.onclick = null;
              });
              qiangmaiSelectingProp = false;
              socket.emit('qiangmaiSelectProp', { propId: spaceId });
            };
          }
        });
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('diaohuStart', ({ playerId }) => {
  if (socket.id === playerId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="diaohuBtn" class="jail-btn">调虎</button><button id="endTurnBtn" class="jail-btn">结束</button>';
      $('diaohuBtn').onclick = () => {
        areaF.innerHTML = '';
        diaohuSelectingTarget = true;
        refreshPlayerCards();
      };
      $('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        diaohuSelectingTarget = false;
        refreshPlayerCards();
        socket.emit('endTurn');
      };
    }
  }
});

socket.on('renwoxingStart', ({ playerId }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = '任我行：请选择一个格子飞过去';
    fitAreaEText();
  }
  if (socket.id === playerId) {
    document.querySelectorAll('.space').forEach(spaceEl => {
      spaceEl.classList.add('highlighted');
      spaceEl.style.cursor = 'pointer';
      spaceEl.style.border = '2px solid #fff';
      spaceEl.onclick = () => {
        document.querySelectorAll('.space.highlighted').forEach(el => {
          el.classList.remove('highlighted');
          el.style.cursor = '';
          el.style.border = '';
          el.onclick = null;
        });
        const spaceId = parseInt(spaceEl.dataset.id);
        socket.emit('renwoxingSelect', { spaceId });
      };
    });
  }
});

socket.on('renwoxingResult', ({ playerInfo, spaceName }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = `${coloredName(playerInfo.name, playerInfo.color)}飞向${spaceName}，获得3张传送卡`;
    fitAreaEText();
  }
  document.querySelectorAll('.space.highlighted').forEach(el => {
    el.classList.remove('highlighted');
    el.style.cursor = '';
    el.style.border = '';
    el.onclick = null;
  });
  const areaF = document.getElementById('areaF');
  if (areaF) areaF.innerHTML = '';
  if (socket.id === playerInfo.id && areaF) {
    const btn = document.createElement('button');
    btn.id = 'endTurnBtn';
    btn.className = 'jail-btn';
    btn.textContent = '结束';
    btn.addEventListener('click', () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    });
    areaF.appendChild(btn);
  }
});

socket.on('nongminStart', ({ playerId, propCount }) => {
  if (socket.id === playerId) {
    nongminSelectedProps = [];
    nongminPropCount = propCount;
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '';
      const btnQiyi = document.createElement('button');
      btnQiyi.className = 'jail-btn';
      btnQiyi.textContent = '起义';
      btnQiyi.addEventListener('click', () => {
        areaF.innerHTML = '';
        socket.emit('nongminConfirm');
      });
      const btnEnd = document.createElement('button');
      btnEnd.className = 'jail-btn';
      btnEnd.textContent = '结束';
      btnEnd.addEventListener('click', () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      });
      areaF.appendChild(btnQiyi);
      areaF.appendChild(btnEnd);
    }
  }
});

socket.on('nongminSelectProps', ({ playerId, propCount }) => {
  if (socket.id === playerId) {
    const areaE = document.getElementById('areaE');
    nongminSelectedProps = [];
    if (propCount >= 4) {
      document.querySelectorAll('.space').forEach(spaceEl => {
        const sid = parseInt(spaceEl.dataset.id);
        const spaceData = window.syncData && window.syncData.board && window.syncData.board.find(s => s.id === sid);
        if (spaceData && spaceData.isProperty && spaceData.owner === socket.id) {
          spaceEl.classList.add('highlighted');
          spaceEl.style.cursor = 'pointer';
          spaceEl.style.border = '2px solid #fff';
          spaceEl.onclick = () => {
            if (nongminSelectedProps.includes(sid)) {
              nongminSelectedProps = nongminSelectedProps.filter(id => id !== sid);
              spaceEl.style.border = '2px solid #fff';
            } else {
              if (nongminSelectedProps.length >= 3) return;
              nongminSelectedProps.push(sid);
              spaceEl.style.border = '3px solid #ff0';
            }
            if (areaE) { areaE.innerHTML = `农民起义：已选${nongminSelectedProps.length}/3块地产`; fitAreaEText(); }
            const areaF = document.getElementById('areaF');
            if (areaF) areaF.innerHTML = '';
            if (nongminSelectedProps.length === 3 && areaF) {
              const btn = document.createElement('button');
              btn.className = 'jail-btn';
              btn.textContent = '确认';
              btn.addEventListener('click', () => {
                document.querySelectorAll('.space.highlighted').forEach(el => {
                  el.classList.remove('highlighted');
                  el.style.cursor = '';
                  el.style.border = '';
                  el.onclick = null;
                });
                socket.emit('nongminSelectPropsConfirm', { propIds: nongminSelectedProps });
              });
              areaF.appendChild(btn);
            }
          };
        }
      });
    } else {
      const myProps = window.syncData && window.syncData.board && window.syncData.board.filter(s => s.isProperty && s.owner === socket.id);
      nongminSelectedProps = myProps.map(s => s.id);
      socket.emit('nongminSelectPropsConfirm', { propIds: nongminSelectedProps });
    }
  }
});

socket.on('nongminSelectTarget', ({ playerId }) => {
  if (socket.id === playerId) {
    selectingNongminTarget = true;
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('nongminResult', ({ playerInfo, targetInfo }) => {
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = `${coloredName(playerInfo.name, playerInfo.color)}与${coloredName(targetInfo.name, targetInfo.color)}互换地产`;
    fitAreaEText();
  }
  selectingNongminTarget = false;
  nongminSelectedProps = [];
  refreshPlayerCards();
  const areaF = document.getElementById('areaF');
  if (areaF) areaF.innerHTML = '';
  if (socket.id === playerInfo.id && areaF) {
    const btn = document.createElement('button');
    btn.id = 'endTurnBtn';
    btn.className = 'jail-btn';
    btn.textContent = '结束';
    btn.addEventListener('click', () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    });
    areaF.appendChild(btn);
  }
});

socket.on('diamondChoice', ({ props, price }) => {
  const current = players[currentPlayerIdx];
  if (current?.id !== myId) return;
  
  const fArea = $('areaF');
  fArea.innerHTML = '<div style="display:flex;gap:8px;justify-content:center;padding:8px;">';
  
  props.forEach((prop) => {
    fArea.innerHTML += `<button class="jail-btn" data-property="${prop.id}">${prop.name}</button>`;
    const spaceEl = document.querySelector(`.space[data-id="${prop.id}"]`);
    if (spaceEl) spaceEl.classList.add('highlighted');
  });
  
  fArea.innerHTML += '<button class="jail-btn" data-property="abandon">放弃</button></div>';
  
  fArea.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.space.highlighted').forEach(el => el.classList.remove('highlighted'));
      const propId = btn.dataset.property;
      if (propId === 'abandon') {
        socket.emit('diamondSelect', { propertyId: null });
      } else {
        socket.emit('diamondSelect', { propertyId: parseInt(propId), price: price });
      }
    };
  });
});

socket.on('diamondRob', ({ holderId, holderName, holderColor, holderMoney, robberMoney }) => {
  const current = players[currentPlayerIdx];
  if (current?.id !== myId) return;
  document.getElementById('areaF').innerHTML = '<button id="robBtn" class="jail-btn">抢夺</button><button id="endTurnBtn" class="jail-btn">结束</button>';
  const robBtn = document.getElementById('robBtn');
  if (robBtn) {
    robBtn.onclick = () => {
      socket.emit('diamondRobFight');
    };
  }
  const endTurnBtn = document.getElementById('endTurnBtn');
  if (endTurnBtn) {
    endTurnBtn.onclick = () => doEndTurn();
  }
});

socket.on('syncCharacters', sel => {
  selectedCharacters = sel;
  const selectedCount = Object.keys(sel).length;
  if (startBtn) {
    startBtn.textContent = `${selectedCount}人开始游戏`;
    startBtn.disabled = selectedCount < 1;
  }
  document.querySelectorAll('.char-box').forEach(box => {
    const c = box.dataset.char;
    if (!c) return;
    const color = c.replace(/\d+$/, '');
    const anyTaken = Object.keys(sel).some(k => k.startsWith(color));
    const isTaken = !!sel[c] || (anyTaken && !sel[c]);
    box.classList.toggle('taken', isTaken);
    if (sel[c] === myId) { box.classList.add('selected'); }
    else if (sel[c] !== myId) box.classList.remove('selected');
  });
});

socket.on('updatePlayers', p => {
  console.log('[DEBUG] updatePlayers received, ids:', p?.map(x=>x.id).join(','), 'myId(before):', myId, 'socket.id:', socket.id);
  players = p;
  // 用 proxy socket 的真实 id 匹配自己（WebRTC 场景下 localStorage 可能被多玩家共享，不能用 savedName）
  if (socket.id) {
    const me = players.find(pl => pl.id === socket.id && !pl.offline);
    if (me) myId = me.id;
  }
  const meOffline = players.some(pl => pl.offline && pl.name === savedName);
  if (meOffline && !isDisconnected) {
    $('gameContainer')?.classList.add('hidden');
    $('actionBar')?.classList.add('hidden');
    $('bottomBar')?.classList.add('hidden');
  } else {
    $('gameContainer')?.classList.remove('hidden');
    $('actionBar')?.classList.remove('hidden');
    $('bottomBar')?.classList.remove('hidden');
  }
  refreshPlayerCards();
  const plEl = $('playerList');
  if (plEl) {
    plEl.innerHTML = p.map(x =>
      `<div class="p-item" style="position:relative;"><div class="dot" style="background:${x.color}"></div><img src="/drawable/juese/${x.character}${x.variant || '2'}.png" style="width:24px;height:24px;"><span style="color:#fff;">${x.name}</span><span class="remove-player-btn" data-player-id="${x.id}" style="position:absolute;top:-6px;right:-6px;width:16px;height:16px;background:#e94560;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:10px;line-height:1;">×</span></div>`
    ).join('');
    // 绑定×按钮点击
    plEl.querySelectorAll('.remove-player-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const pid = btn.dataset.playerId;
        if (pid) socket.emit('removePlayer', { playerId: pid });
      };
    });
  }
  if (startBtn) startBtn.disabled = players.length < 1;
});

socket.on('gameStarted', ({ players: p, board: b, currentPlayerIndex, roundCounter }) => {
  console.log('[DEBUG] gameStarted received, curIdx:', currentPlayerIndex, 'myId:', myId, 'ids:', p?.map(x=>x.id).join(','));
  players = p; board = b; currentPlayerIdx = currentPlayerIndex;
  
  const roundDisplay = $('roundDisplay');
  if (roundDisplay) {
    if (roundCounter !== undefined) {
      roundDisplay.textContent = `第${roundCounter}轮 `;
      roundDisplay.style.color = '#888';
    }
    roundDisplay.style.cursor = 'pointer';
    roundDisplay.onclick = (e) => {
      e.stopPropagation();
      showAreaEHistoryPanel();
    };
    const header = roundDisplay.closest('header');
    if (header) header.style.background = '';
  }
  
  const lobby = $('lobby');
  const game = $('game');
  
  if (!lobby || !game) return;
  
  lobby.classList.add('hidden');
  game.classList.remove('hidden');
  if (settingsWrapper) settingsWrapper.classList.remove('hidden');
  emojiBtn.classList.remove('hidden');
  if (testDiceBtn) testDiceBtn.classList.add('hidden');
  $('disconnectBtn2')?.classList.remove('hidden');
  if (screen.orientation?.lock) screen.orientation.lock('landscape').catch(() => {});
  resetDice();
  
  showThinkingOnce = true;
  render();
});

socket.on('turnUpdate', ({ players: p, board: b, currentPlayerIndex, message, currentDiceValue: serverDiceValue, roundCounter }) => {
  const areaEBefore = $('areaE');
  if (areaEBefore) areaEBefore.style.fontSize = '20px';
  wenjigifwuDiceValues = null;
  liebaoDiceValues = null;
  colorDiceSumValues = null;
  keepGArea = false;
  const prevPlayerIdx = currentPlayerIdx;
  players = p; board = b;
  if (prevPlayerIdx !== currentPlayerIndex) {
    showThinkingOnce = true;
    lastAreaEMessage = '';
  }
  if (serverDiceValue !== undefined) currentDiceValue = serverDiceValue;
  if (currentDiceValue === -1) {
    const areaG = $('areaG');
    if (areaG) areaG.innerHTML = '';
    currentDiceValue = 0;
  }

  const roundDisplay = $('roundDisplay');
    if (roundDisplay && roundCounter !== undefined && roundCounter > 0) {
    roundDisplay.textContent = `第${roundCounter}轮 `;
    const cur = players[currentPlayerIndex];
    roundDisplay.style.color = '#888';
    const header = roundDisplay.closest('header');
    if (header) header.style.background = '';
  }

  if (currentPlayerIdx !== currentPlayerIndex) {
    waitingForTurnEnd = false;
    extraTurnPlayerId = null;
  }

  currentPlayerIdx = currentPlayerIndex;
  const cur = players[currentPlayerIdx];
  const isMyTurn = cur?.id === myId && !cur?.bankrupt;
  if (isMyTurn) activePetUsedThisTurn = false;
  const isExtraTurn = extraTurnPlayerId === cur?.id;

  if (isExtraTurn) {
    waitingForTurnEnd = false;
    showThinkingOnce = true;
  }

  // 出狱等场景：currentDiceValue被重置为-1，清空G区并显示结束
  if (serverDiceValue === -1) {
    currentDiceValue = 0;
    const areaG = $('areaG');
    if (areaG) { areaG.innerHTML = ''; areaG.onclick = null; areaG.style.cursor = 'default'; }
    if (message) {
      const areaE = $('areaE');
      if (areaE) areaE.innerHTML = message;
      fitAreaEText();
    }
    if (isMyTurn) {
      document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
      const endTurnBtn = document.getElementById('endTurnBtn');
      if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
    }
    refreshPlayerCards();
    adjustPlayerNameFontSize();
    return;
  }

  if (cur?.inJail) {
    currentDiceValue = 0;
    const areaG = $('areaG');
    if (areaG) { areaG.innerHTML = ''; areaG.onclick = null; areaG.style.cursor = 'default'; }
  }
  
  if (message) {
    const areaE = $('areaE');
    if (areaE) {
      if (message.includes('保释')) {
        areaE.innerHTML = message;
      } else if (message.includes('出狱') || message.includes('康复') || message.includes('被释放')) {
        areaE.innerHTML = message;
        currentDiceValue = 0;
        const areaG = $('areaG');
        if (areaG) areaG.innerHTML = '';
        if (isMyTurn) {
          document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
          const endTurnBtn = document.getElementById('endTurnBtn');
          if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
        }
      } else if (message.includes('获得钻石')) {
        areaE.innerHTML = message;
      } else if (message.includes('休息')) {
        areaE.innerHTML = message;
        if (isMyTurn) {
          currentDiceValue = 0;
          const areaG = $('areaG');
          if (areaG) areaG.innerHTML = '';
          document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
          const endTurnBtn = document.getElementById('endTurnBtn');
          if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
        }
      } else {
        areaE.innerHTML = message;
      }
    }
    lastAreaEMessage = message;
    showThinkingOnce = false;
  }
  if (awaitingGoToJail) {
    if (isMyTurn) {
      socket.emit('confirmGoToJail');
    }
    return;
  }
  const anyInJail = players.some(p => p.inJail && !p.bankrupt);
  
  const isInJailArea = cur?.inJail && cur?.jailState !== 'leaving';

  if (isMyTurn && currentPlayerIdx !== lastCurrentPlayerIdx) {
    hasShownJudgeBailOptions = false;
  }

  lastCurrentPlayerIdx = currentPlayerIdx;
  
  const anyPlayerInJail = players.some(p => p.inJail && !p.bankrupt);

  if (anyPlayerInJail) {
    if (isInJailArea) {
      isJailMap = true;
      jailMinimized = false;
      renderWithJailPanel(message);
    } else {
      isJailMap = false;
      jailMinimized = false;
      const existingPanel = document.querySelector('.jail-panel');
      if (existingPanel) existingPanel.remove();
      if (message) {
        $('areaE').innerHTML = message;
        fitAreaEText();
      } else if (showThinkingOnce) {
        $('areaE').innerHTML = `${coloredName(cur?.name || '-', cur?.color || '#fff')}正在思考...`;
        fitAreaEText();
        showThinkingOnce = false;
        updateGAreaDiceImage(currentDiceValue, isMyTurn);
        if (document.getElementById('areaF')) {
          if (!treasureClosePending) {
            document.getElementById('areaF').innerHTML = '';
          }
        }
      }
      renderBoardOnly();
      refreshPlayerCards();
      adjustPlayerNameFontSize();
      initTokenClick();
      restoreMoneyIndicators();
    }
  } else {
    isJailMap = false;
    jailMinimized = false;
    const existingPanel = document.querySelector('.jail-panel');
    if (existingPanel) existingPanel.remove();
    render();
  }
});

socket.on('showGoToJail', () => {
  awaitingGoToJail = true;
  const cur = players[currentPlayerIdx];
  const isMyTurn = cur?.id === myId && !cur?.bankrupt;
  if (isMyTurn) {
    socket.emit('confirmGoToJail');
  }
});

socket.on('showJailMap', ({ players: p, board: b, currentPlayerIndex, message, currentDiceValue: serverDiceValue } = {}) => {
  if (p) { players = p; board = b; currentPlayerIdx = currentPlayerIndex; }
  if (serverDiceValue !== undefined) currentDiceValue = serverDiceValue;
  awaitingGoToJail = false;
  isJailMap = true;
  jailMinimized = false;
  renderWithJailPanel(message);
});

socket.on('jailMessage', msg => {
  const areaE = $('areaE');
  if (areaE) {
    if (msg.includes('保释出狱')) {
      areaE.innerHTML = msg.replace('保释出狱', '保释');
    } else {
      areaE.innerHTML = msg;
    }
  }
});

socket.on('islandTreasure', ({ playerId, playerName, playerColor, maze }) => {
  const isMyTurn = playerId === myId;
  let panel = document.getElementById('islandTreasurePanel');
  if (panel) panel.remove();
  panel = document.createElement('div');
  panel.id = 'islandTreasurePanel';
  panel.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:102;display:flex;flex-direction:column;align-items:center;background:#000;overflow:hidden;';
  if (!maze) {
    panel.innerHTML = '<div style="color:#fff;font-size:20px;margin-top:40vh;">' + coloredName(playerName, playerColor) + '正在寻宝</div>';
    document.body.appendChild(panel);
    return;
  }
  const COLS = 15, ROWS = 23, TOTAL = 345;
  const grid = maze.grid;
  const entrance = maze.entrance;
  const charIdx = (Math.random() * 3) | 0;
  let playerPos = entrance;
  let timeLeft = 15, gameActive = false, timerInterval = null, started = false, gameEnded = false;
  function getVisible(p) {
    const s = new Set();
    s.add(p);
    const r = (p / COLS) | 0, c = p % COLS;
    if (r > 0) s.add(p - COLS);
    if (r < ROWS - 1) s.add(p + COLS);
    if (c > 0) s.add(p - 1);
    if (c < COLS - 1) s.add(p + 1);
    return s;
  }
  let visible = isMyTurn ? getVisible(playerPos) : (function() { const s = new Set(); for (let i = 0; i < TOTAL; i++) s.add(i); return s; })();
  const barOuter = document.createElement('div');
  barOuter.style.cssText = 'width:80%;height:12px;background:#333;border-radius:6px;overflow:hidden;flex-shrink:0;margin:4px 0 0 0;';
  const barInner = document.createElement('div');
  barInner.style.cssText = 'width:100%;height:100%;background:#2ecc71;border-radius:6px;transition:width 1s linear;';
  barOuter.appendChild(barInner);
  panel.appendChild(barOuter);
  const gridWrap = document.createElement('div');
  gridWrap.style.cssText = 'flex:1;min-height:0;display:flex;align-items:flex-start;justify-content:center;overflow:hidden;width:100%;position:relative;';
  panel.appendChild(gridWrap);
  const gridEl = document.createElement('div');
  gridEl.id = 'mazeGrid';
  gridEl.style.cssText = 'display:grid;';
  gridWrap.appendChild(gridEl);
  const upBtn = document.createElement('img');
  upBtn.src = '/drawable/ditu/migong/shang.png';
  upBtn.setAttribute('data-maze-btn', '1');
  upBtn.style.cssText = 'position:absolute;bottom:4px;left:50%;transform:translateX(-50%);width:50px;height:50px;cursor:pointer;display:none;z-index:2;';
  if (isMyTurn) { gridWrap.appendChild(upBtn); upBtn.addEventListener('click', () => movePlayer(0)); }
  const bottomRow = document.createElement('div');
  bottomRow.style.cssText = 'flex-shrink:0;padding:4px 10px 10px;display:flex;align-items:center;justify-content:center;gap:4px;min-height:54px;width:100%;box-sizing:border-box;';
  panel.appendChild(bottomRow);
  let startBtn, giveUpBtn, exitBtn, leftBtn, downBtn, rightBtn, resultText;
  if (!isMyTurn) {
    bottomRow.innerHTML = `<span style="color:#fff;font-size:20px;">${coloredName(playerName, playerColor)}正在迷宫找宝藏</span>`;
  } else {
    const spacer1 = document.createElement('div');
    spacer1.style.cssText = 'flex:1;';
    bottomRow.appendChild(spacer1);
    leftBtn = document.createElement('img');
    leftBtn.src = '/drawable/ditu/migong/zuo.png';
    leftBtn.setAttribute('data-maze-btn', '1');
    leftBtn.style.cssText = 'width:clamp(36px,10vw,50px);height:clamp(36px,10vw,50px);cursor:pointer;display:none;';
    downBtn = document.createElement('img');
    downBtn.src = '/drawable/ditu/migong/xia.png';
    downBtn.setAttribute('data-maze-btn', '1');
    downBtn.style.cssText = 'width:clamp(36px,10vw,50px);height:clamp(36px,10vw,50px);cursor:pointer;display:none;';
    rightBtn = document.createElement('img');
    rightBtn.src = '/drawable/ditu/migong/you.png';
    rightBtn.setAttribute('data-maze-btn', '1');
    rightBtn.style.cssText = 'width:clamp(36px,10vw,50px);height:clamp(36px,10vw,50px);cursor:pointer;display:none;';
    bottomRow.appendChild(leftBtn);
    bottomRow.appendChild(downBtn);
    bottomRow.appendChild(rightBtn);
    leftBtn.addEventListener('click', () => movePlayer(2));
    downBtn.addEventListener('click', () => movePlayer(1));
    rightBtn.addEventListener('click', () => movePlayer(3));
    startBtn = document.createElement('div');
    startBtn.style.cssText = 'color:#fff;font-size:20px;padding:10px 40px;background:#000;border:1px solid #fff;border-radius:8px;cursor:pointer;';
    startBtn.textContent = '开始';
    bottomRow.appendChild(startBtn);
    giveUpBtn = document.createElement('div');
    giveUpBtn.style.cssText = 'color:#fff;font-size:20px;padding:10px 40px;background:#000;border:1px solid #fff;border-radius:8px;cursor:pointer;white-space:nowrap;';
    giveUpBtn.textContent = '放弃';
    bottomRow.appendChild(giveUpBtn);
    resultText = document.createElement('span');
    resultText.style.cssText = 'font-size:20px;font-weight:bold;color:#fff;white-space:nowrap;display:none;';
    bottomRow.appendChild(resultText);
    const spacer2 = document.createElement('div');
    spacer2.style.cssText = 'flex:1;';
    bottomRow.appendChild(spacer2);
    exitBtn = document.createElement('div');
    exitBtn.style.cssText = 'color:#fff;font-size:16px;padding:8px 20px;background:#555;border-radius:8px;cursor:pointer;display:none;white-space:nowrap;';
    exitBtn.textContent = '退出';
    bottomRow.appendChild(exitBtn);
  }
  document.body.appendChild(panel);
  panel.__mazeGrid = grid;
  panel.__charIdx = charIdx;
  panel.__playerPos = playerPos;
  const imgMap = ['miwu', 'daolu', 'shu', 'chukou', 'rukou'];
  let prevVisible = new Set();
  let prevPlayerPos = -1;
  function cellBg(i) {
    if (i === playerPos) return 'url(/drawable/ditu/migong/mgjs' + (charIdx + 1) + '.png)';
    if (visible.has(i)) return 'url(/drawable/ditu/migong/' + imgMap[grid[i]] + '.png)';
    return 'url(/drawable/ditu/migong/miwu.png)';
  }
  function render() {
    const rect = gridWrap.getBoundingClientRect();
    const cellW = Math.floor(rect.width / COLS);
    const cellH = Math.floor(rect.height / ROWS);
    const cs = Math.min(cellW, cellH);
    gridEl.style.gridTemplateColumns = 'repeat(' + COLS + ',' + cs + 'px)';
    gridEl.style.gridTemplateRows = 'repeat(' + ROWS + ',' + cs + 'px)';
    if (gridEl.children.length === 0) {
      for (let i = 0; i < TOTAL; i++) {
        const cell = document.createElement('div');
        cell.style.cssText = 'width:' + cs + 'px;height:' + cs + 'px;background-size:cover;background-position:center;background-image:' + cellBg(i) + ';';
        gridEl.appendChild(cell);
      }
    } else {
      const changed = new Set();
      changed.add(playerPos);
      changed.add(prevPlayerPos);
      visible.forEach(i => changed.add(i));
      prevVisible.forEach(i => changed.add(i));
      changed.forEach(i => {
        if (i >= 0 && i < TOTAL && gridEl.children[i]) {
          gridEl.children[i].style.backgroundImage = cellBg(i);
        }
      });
    }
    prevVisible = new Set(visible);
    prevPlayerPos = playerPos;
  }
  function movePlayer(d) {
    if (!gameActive) return;
    const r = (playerPos / COLS) | 0, c = playerPos % COLS;
    const DR = [-1, 1, 0, 0], DC = [0, 0, -1, 1];
    const nr = r + DR[d], nc = c + DC[d];
    if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) return;
    const np = nr * COLS + nc;
    if (grid[np] === 2) return;
    if (grid[np] === 3) {
      gameActive = false;
      gameEnded = true;
      clearInterval(timerInterval);
      onGameEnd(true);
      return;
    }
    if (grid[np] === 1 || grid[np] === 4) {
      playerPos = np;
      visible = getVisible(playerPos);
      render();
      if (isMyTurn) socket.emit('islandTreasureMove', { pos: playerPos });
    }
  }
  function onGameEnd(success) {
    visible = new Set();
    for (let i = 0; i < TOTAL; i++) visible.add(i);
    render();
    if (isMyTurn) {
      upBtn.style.display = 'none';
      leftBtn.style.display = 'none';
      downBtn.style.display = 'none';
      rightBtn.style.display = 'none';
      resultText.textContent = success ? '成功！+20' : '失败！-5';
      resultText.style.display = '';
      exitBtn.style.display = '';
    }
  }
  function startGame() {
    if (started) return;
    started = true;
    gameActive = true;
    startBtn.remove();
    giveUpBtn.remove();
    upBtn.style.display = '';
    leftBtn.style.display = '';
    downBtn.style.display = '';
    rightBtn.style.display = '';
    requestAnimationFrame(render);
    timerInterval = setInterval(() => {
      if (!gameActive) return;
      timeLeft--;
      barInner.style.width = (timeLeft / 15 * 100) + '%';
      if (timeLeft <= 0) { gameActive = false; gameEnded = true; clearInterval(timerInterval); onGameEnd(false); }
    }, 1000);
  }
  if (isMyTurn) startBtn.addEventListener('click', startGame);
  if (isMyTurn) {
    giveUpBtn.addEventListener('click', () => {
      gameActive = false;
      gameEnded = true;
      if (timerInterval) clearInterval(timerInterval);
      socket.emit('islandTreasureResult', { success: false });
    });
  }
  if (isMyTurn) {
    exitBtn.addEventListener('click', () => {
      const success = gameEnded && timeLeft > 0;
      socket.emit('islandTreasureResult', { success });
    });
  }
  if (isMyTurn) {
    let touchStartX = 0, touchStartY = 0;
    panel.addEventListener('touchstart', e => {
      if (e.target.closest('[data-maze-btn]')) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    panel.addEventListener('touchend', e => {
      if (e.target.closest('[data-maze-btn]')) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
      if (Math.abs(dx) > Math.abs(dy)) movePlayer(dx > 0 ? 3 : 2);
      else movePlayer(dy > 0 ? 1 : 0);
    }, { passive: true });
    document.addEventListener('keydown', function mazeKey(e) {
      if (!gameActive) { document.removeEventListener('keydown', mazeKey); return; }
      if (!document.getElementById('islandTreasurePanel')) { document.removeEventListener('keydown', mazeKey); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); movePlayer(0); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); movePlayer(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); movePlayer(2); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); movePlayer(3); }
    });
  }
  requestAnimationFrame(render);
  window.addEventListener('resize', () => { if (document.getElementById('islandTreasurePanel')) render(); });
});

socket.on('islandTreasureMove', ({ pos }) => {
  const panel = document.getElementById('islandTreasurePanel');
  if (!panel) return;
  const gridEl = document.getElementById('mazeGrid');
  if (!gridEl) return;
  const cells = gridEl.children;
  const imgMap = ['miwu', 'daolu', 'shu', 'chukou', 'rukou'];
  const grid = panel.__mazeGrid;
  const charIdx = panel.__charIdx || 0;
  const oldChar = panel.__playerPos;
  if (oldChar !== undefined && cells[oldChar]) {
    cells[oldChar].style.backgroundImage = 'url(/drawable/ditu/migong/' + imgMap[grid[oldChar]] + '.png)';
  }
  if (cells[pos]) {
    cells[pos].style.backgroundImage = 'url(/drawable/ditu/migong/mgjs' + (charIdx + 1) + '.png)';
  }
  panel.__playerPos = pos;
});

socket.on('islandTreasureClosed', ({ currentPlayerId, success, moneyChange, playerName, playerColor }) => {
  const panel = document.getElementById('islandTreasurePanel');
  if (panel) panel.remove();
  if (success === true || success === false) {
    const areaE = document.getElementById('areaE');
    if (areaE) {
      const text = success ? '寻宝成功+' + moneyChange : '寻宝失败' + moneyChange;
      areaE.innerHTML = '<div style="font-size:20px;color:#fff;">' + coloredName(playerName, playerColor) + text + '</div>';
    }
  }
  if (currentPlayerId === myId) {
    treasureClosePending = true;
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
      $('endTurnBtn').onclick = () => doEndTurn();
    }
  }
});

socket.on('clearAreaF', () => {
  const areaF = document.getElementById('areaF');
  if (areaF) areaF.innerHTML = '';
});

socket.on('islandHospitalChoice', ({ playerId }) => {
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    if (areaF) {
      areaF.innerHTML = '<button class="jail-btn" id="islandHospitalBtn">到医院</button><button class="jail-btn" id="islandEndTurnBtn">结束</button>';
      $('islandHospitalBtn').onclick = () => {
        socket.emit('islandGoHospital');
      };
      $('islandEndTurnBtn').onclick = () => {
        doEndTurn();
      };
    }
  }
});

socket.on('islandSwapStart', ({ playerId, playerName, playerColor }) => {
  const boardEl = $('board');
  if (!boardEl) return;
  const me = players.find(p => p.id === myId);
  const maxMoney = me ? (me.money + (me.tempMoney || 0)) : 0;
  if (playerId !== myId && me && !me.bankrupt && !me.sheltered) {
    let panel = document.getElementById('islandBidPanel');
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.id = 'islandBidPanel';
    panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1a2a4a;pointer-events:auto;padding:8px;gap:4px;box-sizing:border-box;overflow:hidden;';
    panel.innerHTML = `
      <div style="color:#fff;font-size:clamp(10px,2.5vw,16px);text-align:center;display:flex;align-items:center;justify-content:center;gap:4px;">${playerName}给你多少钱，你愿意换位到海南？</div>
      <div style="display:flex;align-items:center;gap:6px;">
        <input type="text" id="islandBidPrice" value="0" readonly style="width:60px;text-align:center;font-size:clamp(14px,4vw,28px);background:#fff;color:#000;border:1px solid #666;padding:4px;border-radius:4px;font-weight:bold;">
        <button id="islandBidClear" class="island-bid-btn" disabled style="color:transparent;">清零</button>
        <button id="islandBidConfirm" class="island-bid-btn" disabled style="color:transparent;">确定</button>
      </div>
      <div style="display:flex;gap:4px;">
        <button class="island-bid-btn island-bid-num" data-val="0">0</button>
        <button class="island-bid-btn island-bid-num" data-val="1">1</button>
        <button class="island-bid-btn island-bid-num" data-val="2">2</button>
        <button class="island-bid-btn island-bid-num" data-val="3">3</button>
        <button class="island-bid-btn island-bid-num" data-val="4">4</button>
      </div>
      <div style="display:flex;gap:4px;">
        <button class="island-bid-btn island-bid-num" data-val="5">5</button>
        <button class="island-bid-btn island-bid-num" data-val="6">6</button>
        <button class="island-bid-btn island-bid-num" data-val="7">7</button>
        <button class="island-bid-btn island-bid-num" data-val="8">8</button>
        <button class="island-bid-btn island-bid-num" data-val="9">9</button>
      </div>
      <button id="islandBidReject" style="padding:6px 14px;font-size:clamp(10px,2.5vw,16px);border-radius:8px;background:#e74c3c;color:#fff;border:none;cursor:pointer;">拒绝换位</button>
    `;
    const style = document.createElement('style');
    style.textContent = `.island-bid-btn { min-width:0;flex:1;height:clamp(24px,6vw,50px);background:#333;color:#fff;border:none;border-radius:6px;font-size:clamp(12px,3vw,20px);cursor:pointer;padding:0 4px; } .island-bid-btn:hover { background:#555; } .island-bid-btn:disabled { background:#333 !important; color:transparent !important; opacity:1 !important; }`;
    panel.appendChild(style);
    boardEl.style.position = 'relative';
    boardEl.appendChild(panel);
    
    let currentValue = '0';
    const priceInput = document.getElementById('islandBidPrice');
    const clearBtn = document.getElementById('islandBidClear');
    const confirmBtn = document.getElementById('islandBidConfirm');
    
    const updateDisplay = () => {
      priceInput.value = currentValue;
      if (currentValue === '0') {
        clearBtn.disabled = true;
        clearBtn.style.color = 'transparent';
        confirmBtn.disabled = true;
        confirmBtn.style.color = 'transparent';
      } else {
        clearBtn.disabled = false;
        clearBtn.style.color = '#fff';
        confirmBtn.disabled = false;
        confirmBtn.style.color = '#fff';
      }
    };
    
    document.querySelectorAll('.island-bid-num').forEach(btn => {
      btn.onclick = () => {
        const val = btn.dataset.val;
        let newValue;
        if (currentValue === '0') {
          newValue = val;
        } else {
          newValue = currentValue + val;
        }
        if (parseInt(newValue) > 999) {
          return;
        }
        currentValue = newValue;
        updateDisplay();
      };
    });
    
    clearBtn.onclick = () => {
      currentValue = '0';
      updateDisplay();
    };
    
    confirmBtn.onclick = () => {
      const price = parseInt(currentValue) || 0;
      if (price > 0) {
        socket.emit('islandSwapBid', { price });
        panel.remove();
      }
    };
    
    document.getElementById('islandBidReject').onclick = () => {
      socket.emit('islandSwapReject');
      panel.remove();
    };
  }
});

socket.on('islandSwapSelectTarget', ({ bids }) => {
  selectingIslandSwapTarget = true;
  islandSwapBidsData = bids;
  refreshPlayerCards();
  checkNoValidTarget();
  const areaF = document.getElementById('areaF');
  if (areaF) {
    areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    $('endTurnBtn').onclick = () => doEndTurn();
  }
});

socket.on('islandSwapShowBids', ({ bids }) => {
  islandSwapBidsData = bids;
  refreshPlayerCards();
});

socket.on('islandSwapNoBids', () => {
  selectingIslandSwapTarget = false;
  islandSwapBidsData = [];
  $('areaE').innerHTML = '无人报价';
  fitAreaEText();
  refreshPlayerCards();
  const areaF = document.getElementById('areaF');
  const cur = players[currentPlayerIdx];
  const isMyTurn = cur?.id === myId && !cur?.bankrupt;
  if (isMyTurn && areaF) {
    areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    $('endTurnBtn').onclick = () => doEndTurn();
  }
});

socket.on('islandSwapClear', () => {
  selectingIslandSwapTarget = false;
  islandSwapBidsData = [];
  refreshPlayerCards();
});

socket.on('islandSwapDone', ({ playerId, playerName, playerColor, targetName, targetColor, price }) => {
  const panel = document.getElementById('islandBidPanel');
  if (panel) panel.remove();
  selectingIslandSwapTarget = false;
  islandSwapBidsData = [];
  $('areaE').innerHTML = `${coloredName(playerName, playerColor)}花了${price}与${coloredName(targetName, targetColor)}互换了位置`;
  fitAreaEText();
  refreshPlayerCards();
});

socket.on('showNormalMap', () => {
  isJailMap = false;
  render();
});

socket.on('clearAreaG', () => {
  wenjigifwuDiceValues = null;
  liebaoDiceValues = null;
  colorDiceSumValues = null;
  keepGArea = false;
  const areaG = $('areaG');
  if (areaG) { areaG.innerHTML = ''; areaG.style.cursor = 'default'; areaG.onclick = null; }
});

socket.on('keepGArea', () => {
  keepGArea = true;
});

socket.on('baihuGuess', () => {
  const areaF = document.getElementById('areaF');
  if (!areaF) return;
  areaF.innerHTML = '<button class="jail-btn" data-amount="2">给2</button><button class="jail-btn" data-amount="3">给3</button><button class="jail-btn" data-amount="4">给4</button>';
  areaF.querySelectorAll('[data-amount]').forEach(btn => {
    btn.onclick = () => {
      socket.emit('baihuChoose', { amount: parseInt(btn.dataset.amount) });
    };
  });
});

socket.on('baihuClearF', () => {
  const areaF = document.getElementById('areaF');
  if (areaF) areaF.innerHTML = '';
});

socket.on('showEndTurn', () => {
  window.bingdongProcessingFlag = false;
  closeAirportSpyPanel();
  closeAirportReformPanel();
  closeWuyueReformPanel();

  // 如果E区显示"没有合适的目标"，关闭所有面板
  const areaE = $('areaE');
  if (areaE && areaE.textContent.includes('没有合适的目标')) {
    sansiPanelState = null;
    const sansiPanel = document.getElementById('sansiPanel');
    if (sansiPanel) sansiPanel.remove();
    document.querySelectorAll('.sansi-panel, .sansi-overlay').forEach(el => el.remove());
    const exilePanel = document.getElementById('exilePanel');
    if (exilePanel) exilePanel.remove();
    const wuyuePanel = document.getElementById('wuyueReformPanel');
    if (wuyuePanel) wuyuePanel.remove();
    const airportPanel = document.getElementById('airportReformPanel');
    if (airportPanel) airportPanel.remove();
    const mazePanel = document.getElementById('mazePanel');
    if (mazePanel) mazePanel.remove();
    const texasPanel = document.querySelector('.texas-panel');
    if (texasPanel) texasPanel.remove();
    clearTips();
  }
  
  const cur = players[currentPlayerIdx];
  const isMyTurn = cur?.id === myId && !cur?.bankrupt;
  if (isMyTurn) {
    const curSpace = board[cur?.position];
    const isGaituReformed = curSpace && curSpace.type === 'gaitu' && curSpace.name !== '改土';
    const isWuyueOwned = curSpace && curSpace.name === '五岳' && curSpace.owner === cur.id;
    const isAirportOwned = curSpace && curSpace.name === '机场' && curSpace.owner === cur.id;
    let btns = '';
    if (isGaituReformed && !gaituReformUsed) {
      btns += '<button id="gaituReformBtn" class="jail-btn">改造$7</button>';
    }
    if (isWuyueOwned) {
      btns += '<button id="wuyueReformBtn" class="jail-btn">改造</button>';
    }
    if (isAirportOwned) {
      btns += '<button id="airportReformBtn" class="jail-btn">改造</button>';
    }
    btns += '<button id="endTurnBtn" class="jail-btn">结束</button>';
    document.getElementById('areaF').innerHTML = btns;
    const gaituReformBtn = document.getElementById('gaituReformBtn');
    if (gaituReformBtn) {
      gaituReformBtn.onclick = () => {
        gaituReformBtn.remove();
        gaituReformUsed = true;
        socket.emit('gaituReform');
      };
    }
    const wuyueReformBtn = document.getElementById('wuyueReformBtn');
    if (wuyueReformBtn) {
      wuyueReformBtn.onclick = () => {
        wuyueReformBtn.remove();
        document.getElementById('areaF').innerHTML = '';
        socket.emit('wuyueReform', curSpace.id);
      };
    }
    const airportReformBtn = document.getElementById('airportReformBtn');
    if (airportReformBtn) {
      airportReformBtn.onclick = () => {
        airportReformBtn.remove();
        document.getElementById('areaF').innerHTML = '';
        socket.emit('airportReform', curSpace.id);
      };
    }
    const endTurnBtn = document.getElementById('endTurnBtn');
    if (endTurnBtn) {
      endTurnBtn.onclick = () => {
        doEndTurn();
      };
    }
    if (cur.restTurns > 0) {
      const areaG = $('areaG');
      if (areaG) {
        areaG.innerHTML = '';
        areaG.style.cursor = 'default';
        areaG.onclick = null;
      }
    }
  } else {
    if (!treasureClosePending) {
      document.getElementById('areaF').innerHTML = '';
    }
  }
  refreshPlayerCards();
  adjustPlayerNameFontSize();
  initTokenClick();
  if (selectingGuestTarget) initBoardTileClick();
  restoreMoneyIndicators();
});

socket.on('hideJailMap', () => {
  isJailMap = false;
  jailMinimized = false;
  const existingPanel = document.querySelector('.jail-panel');
  if (existingPanel) existingPanel.remove();
  render();
});

socket.on('showSalaryPanel', ({ players: salaryPlayers, round }) => {
  const playerTexts = salaryPlayers.filter(p => !p.bankrupt).map(p => {
    const loanTotal = (p.loans && p.loans.length > 0) ? p.loans.reduce((sum, l) => sum + l.installment, 0) : 0;
    const loanText = loanTotal > 0 ? `-${loanTotal}` : '';
    return `<span style="color:#fff;">${p.name}+${p.salary}${loanText}</span>`;
  }).join('，');
  showPopupMessage(`<img src="/drawable/fagongzi.jpg" style="width:clamp(96px,24vw,160px);height:clamp(96px,24vw,160px);object-fit:contain;flex-shrink:0;border-radius:8px;"><div style="background:#000;color:#fff;padding:8px 16px;border-radius:6px;font-size:clamp(24px,6vw,40px);">解冻，发放工资，归还贷款，宠物刷新<br>${playerTexts}</div>`);
});

socket.on('changjiangChoice', () => {
  $('areaE').textContent = '长江';
  let btns = '<button id="cjPlusBtn" class="jail-btn">+9</button>';
  btns += '<button id="cjTransformBtn" class="jail-btn">+9变黄河</button>';
  document.getElementById('areaF').innerHTML = btns;
  $('cjPlusBtn').onclick = () => {
    socket.emit('changjiangAction', false);
  };
  $('cjTransformBtn').onclick = () => {
    socket.emit('changjiangAction', true);
  };
});

socket.on('huangheChoice', () => {
  $('areaE').textContent = '黄河';
  let btns = '<button id="hhMinusBtn" class="jail-btn">-10</button>';
  btns += '<button id="hhTransformBtn" class="jail-btn">-10变长江</button>';
  document.getElementById('areaF').innerHTML = btns;
  $('hhMinusBtn').onclick = () => {
    socket.emit('huangheAction', false);
  };
  $('hhTransformBtn').onclick = () => {
    socket.emit('huangheAction', true);
  };
});

socket.on('gaituChoice', () => {
  $('areaE').textContent = '免费改造，本回合/下回合生效';
  showGaituPanel();
});

function showGaituPanel() {
  const boardArea = $('hArea');
  if (!boardArea) return;
  const isMyTurn = players[currentPlayerIdx]?.id === myId;
  const panel = document.createElement('div');
  panel.id = 'gaituPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,1);z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:10px;box-sizing:border-box;overflow-y:auto;';

  const imgRow = document.createElement('div');
  imgRow.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px;width:100%;max-width:400px;';
  gaituTypes.forEach(g => {
    const imgBox = document.createElement('div');
    imgBox.style.cssText = `aspect-ratio:1;${isMyTurn ? 'cursor:pointer;' : 'cursor:default;'}border:2px solid transparent;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#1a1a2e;`;
    imgBox.dataset.gaituName = g.name;
    const img = document.createElement('img');
    img.src = g.image;
    img.style.cssText = 'width:100%;height:100%;object-fit:contain;';
    imgBox.appendChild(img);
    if (isMyTurn) {
      imgBox.onclick = () => {
        panel.querySelectorAll('[data-gaitu-name]').forEach(b => b.style.borderColor = 'transparent');
        imgBox.style.borderColor = '#FFD700';
        descArea.textContent = g.desc;
        btnImmediate.disabled = false;
        btnNextTurn.disabled = false;
        btnImmediate.dataset.gaituName = g.name;
        btnNextTurn.dataset.gaituName = g.name;
      };
    }
    imgRow.appendChild(imgBox);
  });
  panel.appendChild(imgRow);

  const descArea = document.createElement('div');
  descArea.style.cssText = 'color:#fff;font-size:14px;text-align:center;min-height:40px;max-width:600px;line-height:1.5;';
  panel.appendChild(descArea);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:15px;';
  const btnImmediate = document.createElement('button');
  btnImmediate.className = 'jail-btn';
  btnImmediate.textContent = '本回合生效';
  btnImmediate.disabled = true;
  btnImmediate.onclick = () => {
    const name = btnImmediate.dataset.gaituName;
    if (!name) return;
    socket.emit('gaituSelect', { gaituName: name, immediate: true });
  };
  const btnNextTurn = document.createElement('button');
  btnNextTurn.className = 'jail-btn';
  btnNextTurn.textContent = '下回合生效';
  btnNextTurn.disabled = true;
  btnNextTurn.onclick = () => {
    const name = btnNextTurn.dataset.gaituName;
    if (!name) return;
    socket.emit('gaituSelect', { gaituName: name, immediate: false });
  };
  btnRow.appendChild(btnImmediate);
  btnRow.appendChild(btnNextTurn);
  panel.appendChild(btnRow);

  boardArea.style.position = 'relative';
  boardArea.appendChild(panel);
}

socket.on('closeGaituPanel', () => {
  const panel = $('gaituPanel');
  if (panel) panel.remove();
  const guanyinPanel = $('guanyinPanel');
  if (guanyinPanel) guanyinPanel.remove();
});

socket.on('gaituRobChoice', ({ properties }) => {
  selectingWhiteBorderProperty = true;
  properties.forEach(prop => {
    const spaceEl = document.querySelector(`.space[data-id="${prop.id}"]`);
    if (spaceEl) {
      spaceEl.style.outline = '2px solid #fff'; spaceEl.style.outlineOffset = '-2px';
      spaceEl.style.cursor = 'pointer';
      spaceEl.onclick = () => {
        selectingWhiteBorderProperty = false;
        document.querySelectorAll('.space').forEach(el => {
          el.style.outline = '';
          el.style.cursor = '';
          el.onclick = null;
        });
        socket.emit('gaituRobProperty', { propertyId: prop.id });
      };
    }
  });
});

socket.on('clearRobHighlight', () => {
  selectingWhiteBorderProperty = false;
  document.querySelectorAll('.space').forEach(el => {
    el.style.outline = '';
    el.style.cursor = '';
    el.onclick = null;
  });
});

socket.on('gaituDiceHouseChoice', () => {
  let btns = '<button id="dhYesBtn" class="jail-btn">是</button>';
  btns += '<button id="gaituReformBtn2" class="jail-btn">改造$7</button>';
  btns += '<button id="dhEndBtn" class="jail-btn">结束</button>';
  document.getElementById('areaF').innerHTML = btns;
  $('dhYesBtn').onclick = () => {
    document.getElementById('areaF').innerHTML = '';
    socket.emit('gaituDiceHouseYes');
  };
  $('gaituReformBtn2').onclick = () => {
    $('gaituReformBtn2').remove();
    gaituReformUsed = true;
    socket.emit('gaituReform');
  };
  $('dhEndBtn').onclick = () => {
    document.getElementById('areaF').innerHTML = '';
    doEndTurn();
  };
});

socket.on('gaituGuanyinChoice', ({ playerId }) => {
  const boardArea = $('hArea');
  if (!boardArea) return;
  const isMyTurn = playerId === myId;
  const panel = document.createElement('div');
  panel.id = 'guanyinPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,1);z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:clamp(4px,1vh,10px);padding:clamp(4px,1vh,20px);box-sizing:border-box;overflow:hidden;';

  const img = document.createElement('img');
  img.src = '/drawable/ditu/gaitu/guanyinmiao.png';
  img.style.cssText = 'width:clamp(80px,30vw,200px);height:auto;border-radius:8px;flex-shrink:0;';
  panel.appendChild(img);

  const title = document.createElement('div');
  title.style.cssText = 'color:#FFD700;font-size:clamp(10px,2vw,16px);text-align:center;flex-shrink:0;';
  title.textContent = '求签给香火钱有1/6概率净赚5倍';
  panel.appendChild(title);

  const numRow = document.createElement('div');
  numRow.style.cssText = 'display:flex;align-items:center;gap:10px;';
  const numBox = document.createElement('input');
  numBox.type = 'text';
  numBox.id = 'guanyinNum';
  numBox.value = '0';
  numBox.readOnly = true;
  numBox.style.cssText = 'width:clamp(50px,12vw,100px);text-align:center;font-size:clamp(16px,3vw,28px);background:#fff;color:#000;border:1px solid #666;padding:clamp(2px,0.5vh,8px);border-radius:4px;font-weight:bold;';
  if (!isMyTurn) numBox.disabled = true;
  const clearBtn = document.createElement('button');
  clearBtn.className = 'pinqian-calc-btn';
  clearBtn.textContent = '清零';
  clearBtn.disabled = true;
  clearBtn.style.color = 'transparent';
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'pinqian-calc-btn';
  confirmBtn.textContent = '祈福';
  confirmBtn.disabled = true;
  confirmBtn.style.color = 'transparent';
  numRow.appendChild(numBox);
  numRow.appendChild(clearBtn);
  numRow.appendChild(confirmBtn);
  panel.appendChild(numRow);

  const calcStyle = document.createElement('style');
  calcStyle.textContent = `.pinqian-calc-btn { min-width:clamp(30px,6vw,50px);height:clamp(30px,6vw,50px);background:#333;color:#fff;border:none;border-radius:8px;font-size:clamp(12px,2vw,20px);cursor:pointer;padding:0 clamp(4px,1vw,12px);pointer-events:auto; } .pinqian-calc-btn:hover { background:#555; } .pinqian-calc-btn:disabled { background:#333 !important; color:transparent !important; opacity:1 !important; }`;
  panel.appendChild(calcStyle);

  const row1 = document.createElement('div');
  row1.style.cssText = 'display:flex;gap:8px;';
  [1, 2, 3, 4, 5].forEach(n => {
    const btn = document.createElement('button');
    btn.className = 'pinqian-calc-btn pinqian-num';
    btn.dataset.val = String(n);
    btn.textContent = String(n);
    btn.disabled = !isMyTurn;
    row1.appendChild(btn);
  });
  panel.appendChild(row1);

  const row2 = document.createElement('div');
  row2.style.cssText = 'display:flex;gap:8px;';
  [6, 7, 8, 9, 0].forEach(n => {
    const btn = document.createElement('button');
    btn.className = 'pinqian-calc-btn pinqian-num';
    btn.dataset.val = String(n);
    btn.textContent = String(n);
    btn.disabled = !isMyTurn;
    row2.appendChild(btn);
  });
  panel.appendChild(row2);

  let currentValue = '0';
  const updateDisplay = () => {
    numBox.value = currentValue;
    if (currentValue === '0') {
      clearBtn.disabled = true;
      clearBtn.style.color = 'transparent';
      confirmBtn.disabled = true;
      confirmBtn.style.color = 'transparent';
    } else {
      clearBtn.disabled = false;
      clearBtn.style.color = '#fff';
      confirmBtn.disabled = false;
      confirmBtn.style.color = '#fff';
    }
  };

  if (isMyTurn) {
    panel.querySelectorAll('.pinqian-num').forEach(btn => {
      btn.onclick = () => {
        const val = btn.dataset.val;
        if (currentValue === '0') {
          currentValue = val;
        } else {
          currentValue += val;
        }
        updateDisplay();
      };
    });
    clearBtn.onclick = () => {
      currentValue = '0';
      updateDisplay();
    };
    confirmBtn.onclick = () => {
      const amount = parseInt(currentValue) || 0;
      if (amount > 0) socket.emit('gaituGuanyinPray', { amount });
    };
  }

  boardArea.style.position = 'relative';
  boardArea.appendChild(panel);
});

socket.on('gaituSwapChoice', () => {
  selectingSwapTarget = true;
  $('areaE').innerHTML = '请选择其他角色互换位置';
  refreshPlayerCards();
  let btns = '';
  if (!gaituReformUsed) btns += '<button id="gaituReformBtn3" class="jail-btn">改造$7</button>';
  btns += '<button id="endTurnBtn" class="jail-btn">结束</button>';
  document.getElementById('areaF').innerHTML = btns;
  const gaituReformBtn3 = $('gaituReformBtn3');
  if (gaituReformBtn3) {
    gaituReformBtn3.onclick = () => {
      gaituReformBtn3.remove();
      gaituReformUsed = true;
      socket.emit('gaituReform');
    };
  }
  $('endTurnBtn').onclick = () => doEndTurn();
  checkNoValidTarget();
});

socket.on('gaituRouletteChoice', ({ rouletteTargets, rouletteRemaining }) => {
  selectingRouletteTarget = true;
  rouletteExcludedIds = rouletteTargets || [];
  refreshPlayerCards();
  checkNoValidTarget();
});

socket.on('yingmoSelectTarget', () => {
  selectingYingmoTarget = true;
  refreshPlayerCards();
  checkNoValidTarget();
});

socket.on('yingmoPositionUpdate', ({ position, jailed }) => {
  window.yingmoPosition = position;
  renderBoardOnly();
  if (position !== null && (position === 37 || position === 38 || position === 39 || position === 40)) {
    window._pendingYingmoJailShow = true;
  } else if (jailed) {
    window._pendingYingmoJailShow = true;
  }
});

socket.on('riverDone', (msg) => {
  $('areaE').innerHTML = msg;
  document.getElementById('areaF').innerHTML = '<button id="riverEndBtn" class="jail-btn">结束</button>';
  $('riverEndBtn').onclick = () => {
    document.getElementById('areaF').innerHTML = '';
    doEndTurn();
  };
});

socket.on('hezongChoice', () => {
  $('areaE').textContent = '请选择合纵/连横';
  let btns = '<button id="hezongBtn" class="jail-btn">合纵</button>';
  btns += '<button id="lianhenBtn" class="jail-btn">连横</button>';
  document.getElementById('areaF').innerHTML = btns;
  $('hezongBtn').onclick = () => {
    document.getElementById('areaF').innerHTML = '';
    socket.emit('hezongJoin');
  };
  $('lianhenBtn').onclick = () => {
    document.getElementById('areaF').innerHTML = '';
    socket.emit('lianhenAction');
  };
});

socket.on('hezongIncoming', ({ hezongPlayerId, hezongPlayerName }) => {
  $('areaE').textContent = '合纵即将成功，请选择合纵/连横';
  let btns = '<button id="hezongAllianceBtn" class="jail-btn">合纵</button>';
  btns += '<button id="hezongBreakBtn" class="jail-btn">连横</button>';
  document.getElementById('areaF').innerHTML = btns;
  $('hezongAllianceBtn').onclick = () => {
    document.getElementById('areaF').innerHTML = '';
    socket.emit('hezongJoinAlliance', hezongPlayerId);
  };
  $('hezongBreakBtn').onclick = () => {
    document.getElementById('areaF').innerHTML = '';
    socket.emit('hezongBreak');
  };
});

socket.on('dayunPlaceMode', () => {
  selectingDayunPlace = true;
  renderBoardOnly();
});

socket.on('dayunMove', ({ startPos, endPos, roll, passedSpaces, ownerName, ownerColor }) => {
  const boardEl = $('board');
  if (!boardEl) return;
  const startSpaceEl = boardEl.querySelector(`.space[data-id="${startPos}"]`);
  if (!startSpaceEl) return;
  const startRect = startSpaceEl.getBoundingClientRect();
  const boardRect = boardEl.getBoundingClientRect();
  const truck = document.createElement('img');
  truck.src = '/drawable/ditu/gaitu/dayun.png';
  truck.style.cssText = `position:fixed;width:40px;height:40px;z-index:9999;pointer-events:none;transition:all 0.3s ease;`;
  truck.style.left = (startRect.left + startRect.width / 2 - 20) + 'px';
  truck.style.top = (startRect.top + startRect.height / 2 - 20) + 'px';
  document.body.appendChild(truck);
  let step = 0;
  function moveNext() {
    if (step >= passedSpaces.length) {
      setTimeout(() => { truck.remove(); }, 500);
      return;
    }
    const spaceId = passedSpaces[step];
    const spaceEl = boardEl.querySelector(`.space[data-id="${spaceId}"]`);
    if (spaceEl) {
      const rect = spaceEl.getBoundingClientRect();
      truck.style.left = (rect.left + rect.width / 2 - 20) + 'px';
      truck.style.top = (rect.top + rect.height / 2 - 20) + 'px';
    }
    step++;
    setTimeout(moveNext, 400);
  }
  setTimeout(moveNext, 300);
});

socket.on('hezongForced', () => {
  const panel = document.querySelector('.jail-panel');
  if (panel) {
    jailMinimized = true;
    panel.style.display = 'none';
  }
  document.getElementById('areaF').innerHTML = '<button id="hezongEndBtn" class="jail-btn">结束</button>';
  $('areaG').innerHTML = '';
  $('hezongEndBtn').onclick = () => {
    document.getElementById('areaF').innerHTML = '';
    doEndTurn();
  };
});

socket.on('hezongNormal', () => {
  const panel = document.querySelector('.jail-panel');
  if (panel) {
    jailMinimized = true;
    panel.style.display = 'none';
  }
  document.getElementById('areaF').innerHTML = '<button id="hezongStayBtn" class="jail-btn">继续停留</button>';
  $('hezongStayBtn').onclick = () => {
    document.getElementById('areaF').innerHTML = '';
    doEndTurn();
  };
});

socket.on('hezongSelectTarget', ({ otherPlayers, hezongPlayerIds: hzIds }) => {
  selectingHezongTarget = true;
  hezongPlayerIds = hzIds || [];
  $('areaE').textContent = '请选择讨伐目标';
  document.getElementById('areaF').innerHTML = '';
  render();
  checkNoValidTarget();
});

socket.on('hezongResult', ({ success, msg }) => {
  selectingHezongTarget = false;
  waitingHezongTarget = false;
  hezongPlayerIds = [];
  $('areaE').innerHTML = msg;
  fitAreaEText();
  const cur = players[currentPlayerIdx];
  if (cur?.id === myId) {
    document.getElementById('areaF').innerHTML = '<button id="hezongEndBtn" class="jail-btn">结束</button>';
    $('hezongEndBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      doEndTurn();
    };
  } else {
    document.getElementById('areaF').innerHTML = '';
  }
});

socket.on('qiyuSelectProperty', ({ playerId, playerName, playerColor, qiyu }) => {
  selectingWhiteBorderProperty = true;
  showBoardArea();
  renderBoardOnly();
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  document.getElementById('areaF').innerHTML = '';

  if (playerId === myId) {
    document.querySelectorAll('.space').forEach(spaceEl => {
      const spaceId = parseInt(spaceEl.dataset.id);
      const space = board.find(s => s.id === spaceId);
      if (space && space.isProperty && space.owner !== null) {
        spaceEl.style.outline = '2px solid #fff'; spaceEl.style.outlineOffset = '-2px';
        spaceEl.style.cursor = 'pointer';
        spaceEl.onclick = (e) => {
          e.stopPropagation();
          selectingWhiteBorderProperty = false;
          document.querySelectorAll('.space').forEach(s => {
            s.style.outline = '';
            s.style.cursor = '';
            s.onclick = null;
          });
          socket.emit('qiyuPropertySelect', { propertyId: spaceId });
        };
      }
    });
  }
});

socket.on('qiyuComplete', ({ playerId, message }) => {
  selectingWhiteBorderProperty = false;
  document.querySelectorAll('.space').forEach(s => {
    s.style.outline = '';
    s.style.cursor = '';
    s.onclick = null;
  });
  qiyuAnmianyaoSelecting = false;
  qiyuFengdiSelecting = false;
  selectingChuansongPlayerTarget = false;
  selectingFengdiCardTarget = false;
  qiyuBafangQianniuSelecting = false;
  qiyuZaizangSelecting = false;
  qiyuNilaiWangwangSelecting = false;
  qiyuNilaiWangwangCount = 0;
  qiyuNilaiWangwangFirstTarget = null;
  qiyuHunanganshiSelecting = false;
  zangkuanSelectingTarget = false;
  fengkongSelectingTarget = false;
  const xiaotouPanel = document.getElementById('xiaotouPanel');
  if (xiaotouPanel) xiaotouPanel.remove();
  const qianbianPanel = document.getElementById('qianbianPanel');
  if (qianbianPanel) qianbianPanel.remove();
  $('areaE').innerHTML = message;
  fitAreaEText();
});

socket.on('qiyuXixinYanjiu', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  
  if (playerId === myId) {
    document.getElementById('areaF').innerHTML = '<button id="xixinHuanxinBtn" class="jail-btn">换新</button><button id="xixinEndBtn" class="jail-btn">结束</button>';
    document.getElementById('xixinHuanxinBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('qiyuXixinYanjiuConfirm');
    };
    document.getElementById('xixinEndBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('endTurn');
    };
  }
});

socket.on('qiyuAnmianyao', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  
  if (playerId === myId) {
    qiyuAnmianyaoSelecting = true;
    document.getElementById('areaF').innerHTML = '';
    render();
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('qiyuBaguan', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();

  if (playerId === myId) {
    document.getElementById('areaF').innerHTML = '<button id="baguanBtn" class="jail-btn">拔罐</button><button id="baguanEndBtn" class="jail-btn">结束</button>';
    document.getElementById('baguanEndBtn').onclick = () => {
      qiyuBaguanSelecting = false;
      document.getElementById('areaF').innerHTML = '';
      socket.emit('endTurn');
    };
    document.getElementById('baguanBtn').onclick = () => {
      qiyuBaguanSelecting = true;
      document.getElementById('areaF').innerHTML = '';
      render();
      refreshPlayerCards();
      checkNoValidTarget();
    };
  }
});

socket.on('qiyuBaguanResult', ({ playerId }) => {
  if (playerId === myId) {
    document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    document.getElementById('endTurnBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('endTurn');
    };
  }
});

socket.on('qiyuFengdi', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  
  if (playerId === myId) {
    qiyuFengdiSelecting = true;
    document.getElementById('areaF').innerHTML = '';
    render();
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('jiyuCardShowWithOption', ({ name, desc, playerId }) => {
  $('areaE').innerHTML = `${name}：${desc}`;
  fitAreaEText();
  const cur = players[currentPlayerIdx];
  if (cur?.id === myId) {
    let btns = `<button id="jiyuUseBtn" class="jail-btn">${name}</button>`;
    btns += '<button id="jiyuEndBtn" class="jail-btn">结束</button>';
    document.getElementById('areaF').innerHTML = btns;
    $('jiyuUseBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('jiyuCardUse');
    };
    $('jiyuEndBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      doEndTurn();
    };
  } else {
    document.getElementById('areaF').innerHTML = '';
  }
});

socket.on('qiyuNoEffect', ({ message, playerId }) => {
  // 关闭所有面板
  const sansiPanel = document.getElementById('sansiPanel');
  if (sansiPanel) sansiPanel.remove();
  document.querySelectorAll('.sansi-panel, .sansi-overlay').forEach(el => el.remove());
  const exilePanel = document.getElementById('exilePanel');
  if (exilePanel) exilePanel.remove();
  const wuyuePanel = document.getElementById('wuyueReformPanel');
  if (wuyuePanel) wuyuePanel.remove();
  const airportPanel = document.getElementById('airportReformPanel');
  if (airportPanel) airportPanel.remove();
  const mazePanel = document.getElementById('mazePanel');
  if (mazePanel) mazePanel.remove();
  const texasPanel = document.querySelector('.texas-panel');
  if (texasPanel) texasPanel.remove();
  clearTips();
  $('areaE').innerHTML = message;
  fitAreaEText();
  if (playerId === myId) {
    document.getElementById('areaF').innerHTML = '<button id="noEffectEndBtn" class="jail-btn">结束</button>';
    document.getElementById('noEffectEndBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('endTurn');
    };
  }
});

socket.on('jinmenShowOptions', () => {
  const areaF = document.getElementById('areaF');
  if (!areaF) return;
  areaF.innerHTML = '<button class="jail-btn" onclick="socket.emit(\'jinmenUseKey\')">金门</button><button class="jail-btn" onclick="doEndTurn()">结束</button>';
});

socket.on('qiyuGuoneiLvyou', ({ playerId }) => {
  $('areaE').innerHTML = '国内旅游:到港/澳/台';
  fitAreaEText();
  if (playerId === myId) {
    guoneiLvyouSelecting = true;
    render();
  }
});

let zagumaitieSelecting = false;
let zibaoSelectingProp = false;
let shenbingSelectingTarget = false;

socket.on('zagumaitieSelect', ({ playerId, playerColor }) => {
  if (playerId === myId) {
    zagumaitieSelecting = true;
    render();
  }
});

socket.on('zagumaitieShowOptions', ({ propertyId, propertyName }) => {
  zagumaitieSelecting = false;
  document.getElementById('areaF').innerHTML = `<button id="sellToBankBtn" class="jail-btn">拍给银行</button><button id="sellToPlayerBtn" class="jail-btn">拍给玩家</button>`;
  document.getElementById('sellToBankBtn').onclick = () => {
    document.getElementById('areaF').innerHTML = '';
    socket.emit('zagumaitieSellToBank');
  };
  document.getElementById('sellToPlayerBtn').onclick = () => {
    document.getElementById('areaF').innerHTML = '';
    socket.emit('zagumaitieSellToPlayer');
  };
});

socket.on('qiyuBafangQianniu', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  
  if (playerId === myId) {
    qiyuBafangQianniuSelecting = true;
    document.getElementById('areaF').innerHTML = '';
    render();
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('qiyuZaizang', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  
  if (playerId === myId) {
    document.getElementById('areaF').innerHTML = '<button id="zaizangBtn" class="jail-btn">栽赃</button><button id="zaizangEndBtn" class="jail-btn">结束</button>';
    document.getElementById('zaizangBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('qiyuZaizangConfirm');
    };
    document.getElementById('zaizangEndBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('endTurn');
    };
  }
});

socket.on('qiyuZaizangSelectTarget', ({ playerId }) => {
  if (playerId === myId) {
    qiyuZaizangSelecting = true;
    document.getElementById('areaF').innerHTML = '';
    render();
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('qiyuNilaiWangwang', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  
  if (playerId === myId) {
    document.getElementById('areaF').innerHTML = '<button id="nilaiBtn" class="jail-btn">来往</button><button id="nilaiEndBtn" class="jail-btn">结束</button>';
    document.getElementById('nilaiEndBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('endTurn');
    };
    document.getElementById('nilaiBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('nilaiWangwangStart');
    };
    render();
  }
});

socket.on('nilaiWangwangSelectingTarget', ({ playerId }) => {
  if (playerId === myId) {
    qiyuNilaiWangwangSelecting = true;
    qiyuNilaiWangwangCount = 0;
    qiyuNilaiWangwangFirstTarget = null;
    render();
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('qiyuNilaiWangwangSelectSecond', ({ playerId, firstTargetId }) => {
  if (playerId === myId) {
    qiyuNilaiWangwangFirstTarget = firstTargetId;
    refreshPlayerCards();
  }
});

socket.on('qiyuMeirenji', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    document.getElementById('areaF').innerHTML = '<button id="meirenjiBtn" class="jail-btn">美人计</button><button id="meirenjiEndBtn" class="jail-btn">结束</button>';
    document.getElementById('meirenjiEndBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('endTurn');
    };
    document.getElementById('meirenjiBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('meirenjiStart');
    };
    render();
  }
});

socket.on('meirenjiSelectingTarget', ({ playerId }) => {
  if (playerId === myId) {
    qiyuMeirenjiSelecting = true;
    qiyuMeirenjiFirstTarget = null;
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('qiyuMeirenjiSelectSecond', ({ playerId, firstTargetId }) => {
  if (playerId === myId) {
    qiyuMeirenjiFirstTarget = firstTargetId;
    refreshPlayerCards();
  }
});

socket.on('meirenjiPanel', ({ commanderId, commanderName, target1Id, target1Name, target1Color, target2Id, target2Name, target2Color }) => {
  qiyuMeirenjiSelecting = false;
  qiyuMeirenjiFirstTarget = null;
  refreshPlayerCards();
  if (myId === target1Id || myId === target2Id) {
    const me = players.find(p => p.id === myId);
    const maxMoney = me ? (me.money + (me.tempMoney || 0)) : 0;
    const myName = myId === target1Id ? target1Name : target2Name;
    const panel = document.createElement('div');
    panel.id = 'meirenjiOverlay';
    panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:200;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1a2a4a;gap:1vh;overflow:hidden;';
    panel.innerHTML = `
      <div style="color:#fff;font-size:clamp(12px,2vh,16px);text-align:center;">给${commanderName}钱，钱少的房屋降级/-10</div>
      <div style="display:flex;align-items:center;gap:1vh;">
        <input id="meirenjiBidInput" type="text" value="0" readonly style="width:12vh;text-align:center;font-size:clamp(18px,3vh,28px);background:#fff;color:#000;border:1px solid #666;padding:1vh;border-radius:4px;font-weight:bold;">
        <button id="meirenjiClearBtn" class="meirenji-calc-btn" disabled style="color:transparent;">清零</button>
        <button id="meirenjiConfirmBtn" class="meirenji-calc-btn" disabled style="color:transparent;">确定</button>
      </div>
      <div style="display:flex;gap:1vh;">
        <button class="meirenji-calc-btn meirenji-num" data-val="0">0</button>
        <button class="meirenji-calc-btn meirenji-num" data-val="1">1</button>
        <button class="meirenji-calc-btn meirenji-num" data-val="2">2</button>
        <button class="meirenji-calc-btn meirenji-num" data-val="3">3</button>
        <button class="meirenji-calc-btn meirenji-num" data-val="4">4</button>
      </div>
      <div style="display:flex;gap:1vh;">
        <button class="meirenji-calc-btn meirenji-num" data-val="5">5</button>
        <button class="meirenji-calc-btn meirenji-num" data-val="6">6</button>
        <button class="meirenji-calc-btn meirenji-num" data-val="7">7</button>
        <button class="meirenji-calc-btn meirenji-num" data-val="8">8</button>
        <button class="meirenji-calc-btn meirenji-num" data-val="9">9</button>
      </div>
    `;
    const style = document.createElement('style');
    style.textContent = `.meirenji-calc-btn { min-width:6vh;height:6vh;background:#333;color:#fff;border:none;border-radius:8px;font-size:clamp(14px,2vh,20px);cursor:pointer;padding:0 1.5vh; } .meirenji-calc-btn:hover { background:#555; } .meirenji-calc-btn:disabled { background:#333 !important; color:transparent !important; opacity:1 !important; }`;
    panel.appendChild(style);
    document.getElementById('hArea').appendChild(panel);

    let currentValue = '0';
    const bidInput = document.getElementById('meirenjiBidInput');
    const clearBtn = document.getElementById('meirenjiClearBtn');
    const confirmBtn = document.getElementById('meirenjiConfirmBtn');

    const updateDisplay = () => {
      bidInput.value = currentValue;
      if (currentValue === '0') {
        clearBtn.disabled = true;
        clearBtn.style.color = 'transparent';
        confirmBtn.disabled = true;
        confirmBtn.style.color = 'transparent';
      } else {
        clearBtn.disabled = false;
        clearBtn.style.color = '#fff';
        confirmBtn.disabled = false;
        confirmBtn.style.color = '#fff';
      }
    };

    document.querySelectorAll('.meirenji-num').forEach(btn => {
      btn.onclick = () => {
        const val = btn.dataset.val;
        let newValue;
        if (currentValue === '0') {
          newValue = val;
        } else {
          newValue = currentValue + val;
        }
        if (parseInt(newValue) > 999) {
          return;
        }
        currentValue = newValue;
        updateDisplay();
      };
    });

    clearBtn.onclick = () => {
      currentValue = '0';
      updateDisplay();
    };

    confirmBtn.onclick = () => {
      const amount = parseInt(currentValue) || 0;
      if (amount <= 0) return;
      panel.remove();
      socket.emit('meirenjiBid', { targetId: myId, amount });
    };
  }
});

socket.on('meirenjiEnd', ({ commanderId }) => {
  const panel = document.getElementById('meirenjiOverlay');
  if (panel) panel.remove();
  if (commanderId === myId) {
    document.getElementById('areaF').innerHTML = '<button class="jail-btn" onclick="socket.emit(\'endTurn\')">结束</button>';
  }
});

socket.on('qiyuGuhuo', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    qiyuGuhuoSelecting = true;
    render();
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('qiyuGuhuoDice', ({ playerId, targetId, targetName, targetColor }) => {
  if (playerId === myId) {
    qiyuGuhuoSelecting = false;
    render();
    showDiceSelectInF(1, 6, (i) => {
      socket.emit('qiyuGuhuoDiceSelect', { targetId, diceValue: i });
    });
  }
});

socket.on('qiyuGanjinJuejue', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    qiyuGanjinJuejueSelecting = true;
    render();
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('qiyuHunanganshi', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    qiyuHunanganshiSelecting = true;
    render();
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('zangkuanStart', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '<button id="zangkuanBtn" class="jail-btn">赃款</button><button id="zangkuanEndBtn" class="jail-btn">结束</button>';
    $('zangkuanBtn').onclick = () => {
      areaF.innerHTML = '';
      zangkuanSelectingTarget = true;
      render();
    };
    $('zangkuanEndBtn').onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
  }
});

socket.on('xiaotouStart', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '<button id="xiaotouBtn" class="jail-btn">小偷</button><button id="xiaotouEndBtn" class="jail-btn">结束</button>';
    $('xiaotouBtn').onclick = () => {
      areaF.innerHTML = '';
      const othersWithCards = players.filter(p => p.id !== myId && !p.bankrupt && p.cards && p.cards.length > 0);
      if (othersWithCards.length === 0) {
        $('areaE').innerHTML = '他人没有卡片';
        fitAreaEText();
        areaF.innerHTML = '<button id="xiaotouNoCardEndBtn" class="jail-btn">结束</button>';
        $('xiaotouNoCardEndBtn').onclick = () => {
          areaF.innerHTML = '';
          socket.emit('endTurn');
        };
        return;
      }
      showXiaotouPanel(othersWithCards);
    };
    $('xiaotouEndBtn').onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
  }
});

socket.on('qianbianStart', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    const me = players.find(p => p.id === myId);
    const allPlayersWithCards = players.filter(p => !p.bankrupt && p.cards && p.cards.length > 0);
    const hasAnyCards = allPlayersWithCards.length > 0;
    areaF.innerHTML = '<button id="qianbianBtn" class="jail-btn">千变</button><button id="qianbianEndBtn" class="jail-btn">结束</button>';
    $('qianbianBtn').onclick = () => {
      areaF.innerHTML = '';
      if (!hasAnyCards) {
        $('areaE').innerHTML = '没有卡片';
        fitAreaEText();
        areaF.innerHTML = '<button id="qianbianNoCardEndBtn" class="jail-btn">结束</button>';
        $('qianbianNoCardEndBtn').onclick = () => {
          areaF.innerHTML = '';
          socket.emit('endTurn');
        };
        return;
      }
      showQianbianPanel(allPlayersWithCards);
    };
    $('qianbianEndBtn').onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
  }
});

socket.on('canzhiStart', ({ playerId, playerName, playerColor, qiyu, propertyName, propertyId }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}（${propertyName}）`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '<button id="canzhiLufeiBtn" class="jail-btn">路费-3</button><button id="canzhiPandingBtn" class="jail-btn">判定</button>';
    $('canzhiLufeiBtn').onclick = () => {
      areaF.innerHTML = '';
      socket.emit('canzhiLufei');
    };
    $('canzhiPandingBtn').onclick = () => {
      areaF.innerHTML = '';
      socket.emit('canzhiPanding');
    };
  }
});

let fengkongSelectingTarget = false;

socket.on('yianStart', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '<button id="yianBtn" class="jail-btn">议案</button><button id="yianEndBtn" class="jail-btn">结束</button>';
    $('yianBtn').onclick = () => {
      areaF.innerHTML = '';
      const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== myId);
      if (validTargets.length < 2) {
        $('areaE').innerHTML = '没有足够的目标';
        fitAreaEText();
        areaF.innerHTML = '<button id="yianNoTargetEndBtn" class="jail-btn">结束</button>';
        $('yianNoTargetEndBtn').onclick = () => { areaF.innerHTML = ''; socket.emit('endTurn'); };
        return;
      }
      socket.emit('yianRequestTargets');
    };
    $('yianEndBtn').onclick = () => { areaF.innerHTML = ''; socket.emit('endTurn'); };
  }
});

socket.on('yianRandomTargets', ({ targetAId, targetAName, targetAColor, targetBId, targetBName, targetBColor }) => {
  showYianPanel(targetAName, targetAColor, targetBName, targetBColor);
});

socket.on('yianTargets', ({ proposerId, proposerName, proposerColor, targetAId, targetAName, targetAColor, targetBId, targetBName, targetBColor, amount }) => {
  const panel = document.getElementById('yianPanel');
  if (panel) panel.remove();
  $('areaE').innerHTML = `${coloredName(targetAName, targetAColor)}，${coloredName(targetBName, targetBColor)}请选择令${coloredName(proposerName, proposerColor)}的议案成功/失败，仅1人选成功可+${amount}`;
  fitAreaEText();
  if (targetAId === myId || targetBId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '<button id="yianSuccessBtn" class="jail-btn">成功</button><button id="yianFailBtn" class="jail-btn">失败</button>';
    $('yianSuccessBtn').onclick = () => { areaF.innerHTML = ''; socket.emit('yianChoose', { choice: 'success' }); };
    $('yianFailBtn').onclick = () => { areaF.innerHTML = ''; socket.emit('yianChoose', { choice: 'fail' }); };
  }
});

socket.on('yianProgress', ({ playerId, choice }) => {
});

socket.on('yianEnd', ({ proposerId }) => {
  const panel = document.getElementById('yianPanel');
  if (panel) panel.remove();
  if (proposerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '<button id="yianFinalEndBtn" class="jail-btn">结束</button>';
    $('yianFinalEndBtn').onclick = () => { areaF.innerHTML = ''; socket.emit('endTurn'); };
  }
});

socket.on('fengkongStart', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '<button id="fengkongBtn" class="jail-btn">封控</button><button id="fengkongEndBtn" class="jail-btn">结束</button>';
    $('fengkongBtn').onclick = () => {
      areaF.innerHTML = '';
      fengkongSelectingTarget = true;
      render();
    };
    $('fengkongEndBtn').onclick = () => { areaF.innerHTML = ''; socket.emit('endTurn'); };
  }
});

socket.on('fengkongSelectDice', ({ controllerId, targetId, targetName, targetColor, selectorIds }) => {
  $('areaE').innerHTML = `${coloredName(targetName, targetColor)}被封控，请选择点数令他下回合不能掷出`;
  fitAreaEText();
  if (selectorIds.includes(myId)) {
    showFengkongDicePanel(targetId);
  }
});

socket.on('fengkongProgress', ({ playerId, selected }) => {
});

socket.on('fengkongEnd', ({ controllerId }) => {
  const panel = document.getElementById('diceSelectInF');
  if (panel) panel.remove();
  if (controllerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '<button id="fengkongFinalEndBtn" class="jail-btn">结束</button>';
    $('fengkongFinalEndBtn').onclick = () => { areaF.innerHTML = ''; socket.emit('endTurn'); };
  }
});

socket.on('qiyuLianyin', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const myProps = board.filter(s => s.isProperty && s.owner === myId);
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    if (myProps.length > 0) {
      const lianyinBtn = document.createElement('button');
      lianyinBtn.textContent = '联姻';
      lianyinBtn.className = 'jail-btn';
      lianyinBtn.onclick = () => {
        areaF.innerHTML = '';
        qiyuLianyinSelectingProp = true;
        render();
      };
      areaF.appendChild(lianyinBtn);
    }
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      qiyuLianyinSelectingProp = false;
      qiyuLianyinSelectingTarget = false;
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuLianyinSelectTarget', ({ playerId, propId, propName }) => {
  if (playerId === myId) {
    qiyuLianyinSelectingProp = false;
    qiyuLianyinSelectingTarget = true;
    qiyuLianyinPropId = propId;
    render();
  }
});

socket.on('qiyuYinhuoDefu', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const myProps = board.filter(s => s.isProperty && s.owner === myId);
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    if (myProps.length > 0) {
      const yinhuoBtn = document.createElement('button');
      yinhuoBtn.textContent = '因祸得福';
      yinhuoBtn.className = 'jail-btn';
      yinhuoBtn.onclick = () => {
        areaF.innerHTML = '';
        qiyuYinhuoDefuSelecting = true;
        render();
      };
      areaF.appendChild(yinhuoBtn);
    }
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      qiyuYinhuoDefuSelecting = false;
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuTangying', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const tangyingBtn = document.createElement('button');
    tangyingBtn.textContent = '躺赢';
    tangyingBtn.className = 'jail-btn';
    tangyingBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('qiyuTangying');
    };
    areaF.appendChild(tangyingBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuChuanxiaoTrigger', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const chuanxiaoBtn = document.createElement('button');
    chuanxiaoBtn.textContent = '传销';
    chuanxiaoBtn.className = 'jail-btn';
    chuanxiaoBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('qiyuChuanxiao');
    };
    areaF.appendChild(chuanxiaoBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuChuanxiaoStart', ({ playerId, playerName, playerColor }) => {
  isJailMap = true;
  chuanxiaoPinqianActive = true;
  
  const boardEl = $('board');
  if (!boardEl) return;
  
  const me = players.find(p => p.id === myId);
  const maxMoney = me ? (me.money + (me.tempMoney || 0)) : 0;
  
  const existingPanel = $('pinqianPanel');
  if (existingPanel) existingPanel.remove();
  
  const panel = document.createElement('div');
  panel.id = 'pinqianPanel';
  panel.style.position = 'absolute';
  panel.style.top = '0';
  panel.style.left = '0';
  panel.style.right = '0';
  panel.style.bottom = '0';
  panel.style.zIndex = '100';
  panel.style.pointerEvents = 'auto';
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.alignItems = 'center';
  panel.style.justifyContent = 'center';
  panel.style.background = '#1a2a4a';
  panel.style.gap = '6px';
  panel.style.padding = '8px';
  panel.style.overflow = 'hidden';
  
  panel.innerHTML = `
    <img src="/drawable/pinqian.png" style="width:clamp(80px,30vw,200px);height:auto;border-radius:8px;">
    <div style="display:flex;align-items:center;gap:6px;">
      <input type="text" id="pinqianNumber" value="0" readonly style="width:clamp(60px,15vw,100px);text-align:center;font-size:clamp(16px,4vw,28px);background:#fff;color:#000;border:1px solid #666;padding:4px;border-radius:4px;font-weight:bold;">
      <button id="pinqianClearBtn" class="pinqian-calc-btn" disabled style="color:transparent;">清零</button>
      <button id="pinqianConfirmBtn" class="pinqian-calc-btn" disabled style="color:transparent;">确定</button>
    </div>
    <div style="display:flex;gap:4px;">
      <button class="pinqian-calc-btn pinqian-num" data-val="0">0</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="1">1</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="2">2</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="3">3</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="4">4</button>
    </div>
    <div style="display:flex;gap:4px;">
      <button class="pinqian-calc-btn pinqian-num" data-val="5">5</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="6">6</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="7">7</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="8">8</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="9">9</button>
    </div>
  `;
  
  const style = document.createElement('style');
  style.textContent = `.pinqian-calc-btn { min-width:clamp(30px,8vw,50px);height:clamp(30px,8vw,50px);background:#333;color:#fff;border:none;border-radius:8px;font-size:clamp(14px,3.5vw,20px);cursor:pointer;padding:0 8px;pointer-events:auto; } .pinqian-calc-btn:hover { background:#555; } .pinqian-calc-btn:disabled { background:#333 !important; color:transparent !important; opacity:1 !important; }`;
  panel.appendChild(style);
  
  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);
  
  let currentValue = '0';
  const updateDisplay = () => {
    const numEl = $('pinqianNumber');
    const clearBtn = $('pinqianClearBtn');
    const confirmBtn = $('pinqianConfirmBtn');
    if (numEl) numEl.value = currentValue;
    if (clearBtn && confirmBtn) {
      if (currentValue === '0') {
        clearBtn.disabled = true;
        clearBtn.style.color = 'transparent';
        confirmBtn.disabled = true;
        confirmBtn.style.color = 'transparent';
      } else {
        clearBtn.disabled = false;
        clearBtn.style.color = '#fff';
        confirmBtn.disabled = false;
        confirmBtn.style.color = '#fff';
      }
    }
  };
  
  document.querySelectorAll('.pinqian-num').forEach(btn => {
    btn.onclick = () => {
      const val = btn.dataset.val;
      let newValue;
      if (currentValue === '0') {
        newValue = val;
      } else {
        newValue = currentValue + val;
      }
      if (parseInt(newValue) > 999) {
        return;
      }
      currentValue = newValue;
      updateDisplay();
    };
  });
  
  const clearBtn = $('pinqianClearBtn');
  if (clearBtn) {
    clearBtn.onclick = () => {
      currentValue = '0';
      updateDisplay();
    };
  }
  
  const confirmBtn = $('pinqianConfirmBtn');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      const value = parseInt(currentValue) || 0;
      socket.emit('chuanxiaoPinqianConfirmWithValue', value);
    };
  }
});

socket.on('chuanxiaoPinqianUpdate', ({ number }) => {
  const numEl = $('pinqianNumber');
  if (numEl) numEl.value = number;
  const confirmBtn = $('pinqianConfirmBtn');
  if (confirmBtn) {
    if (number > 0) {
      confirmBtn.disabled = false;
      confirmBtn.style.color = '#fff';
    } else {
      confirmBtn.disabled = true;
      confirmBtn.style.color = 'transparent';
    }
  }
});

socket.on('chuanxiaoPinqianConfirmed', () => {
  const pnl = $('pinqianPanel');
  if (pnl) pnl.remove();
  document.getElementById('areaF').innerHTML = '';
  $('areaE').textContent = '等待其他人拼钱...';
});

socket.on('qiyuChuanxiaoEnd', () => {
  const pnl = $('pinqianPanel');
  if (pnl) pnl.remove();
  isJailMap = false;
  chuanxiaoPinqianActive = false;
  document.getElementById('areaF').innerHTML = '';
  const cur = players[currentPlayerIdx];
  if (cur?.id === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    $('endTurnBtn').onclick = () => doEndTurn();
  }
  render();
});

let qiyuBomingSelecting = false;

socket.on('qiyuBoming', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const bomingBtn = document.createElement('button');
    bomingBtn.textContent = '搏命';
    bomingBtn.className = 'jail-btn';
    bomingBtn.onclick = () => {
      areaF.innerHTML = '';
      qiyuBomingSelecting = true;
      render();
      refreshPlayerCards();
      checkNoValidTarget();
    };
    areaF.appendChild(bomingBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      qiyuBomingSelecting = false;
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuJiefuJipin', ({ playerId, playerName, playerColor, qiyu }) => {
  // 已改用jiyuCardShowWithOption机制，此handler保留兼容
});

socket.on('qiyuLunliuzhuan', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const lunliuzhuanBtn = document.createElement('button');
    lunliuzhuanBtn.textContent = '轮流转';
    lunliuzhuanBtn.className = 'jail-btn';
    lunliuzhuanBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('qiyuLunliuzhuan');
    };
    areaF.appendChild(lunliuzhuanBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuLunliuzhuanDone', () => {
  const cur = players[currentPlayerIdx];
  if (cur?.id === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    $('endTurnBtn').onclick = () => doEndTurn();
  }
});

socket.on('qiyuXianjinLiushui', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const xianjinBtn = document.createElement('button');
    xianjinBtn.textContent = '现金';
    xianjinBtn.className = 'jail-btn';
    xianjinBtn.onclick = () => {
      xianjinBtn.remove();
      socket.emit('qiyuXianjinLiushui');
    };
    areaF.appendChild(xianjinBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuXianjinLiushuiFail', () => {
  $('areaE').innerHTML = '现金＞40，无法补充';
  fitAreaEText();
});

socket.on('qiyuZoushoufanzi', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const zoushouBtn = document.createElement('button');
    zoushouBtn.textContent = '走私';
    zoushouBtn.className = 'jail-btn';
    zoushouBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('qiyuZoushoufanzi');
    };
    areaF.appendChild(zoushouBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

let qiyuJinzuSelecting = false;
let qiyuLiufangSelecting = false;
let qiyuJiebanWanleSelecting = false;
let qiyuTuoleiSelecting = false;
let qiyuFuwufeiSelecting = false;
let qiyuAiwuJiwuSelecting = false;
let qiyuTudijianbingSelectingTarget = false;
let qiyuTudijianbingSelectingProperty = false;

socket.on('qiyuJinzu', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const jinzuBtn = document.createElement('button');
    jinzuBtn.textContent = '禁足';
    jinzuBtn.className = 'jail-btn';
    jinzuBtn.onclick = () => {
      areaF.innerHTML = '';
      qiyuJinzuSelecting = true;
      render();
      refreshPlayerCards();
      checkNoValidTarget();
    };
    areaF.appendChild(jinzuBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      qiyuJinzuSelecting = false;
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuLeshanHaoshi', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const haoshiBtn = document.createElement('button');
    haoshiBtn.textContent = '好施';
    haoshiBtn.className = 'jail-btn';
    haoshiBtn.onclick = () => {
      haoshiBtn.remove();
      socket.emit('qiyuLeshanHaoshiConfirm');
    };
    areaF.appendChild(haoshiBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuLiufang', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const liufangBtn = document.createElement('button');
    liufangBtn.textContent = '流放';
    liufangBtn.className = 'jail-btn';
    liufangBtn.onclick = () => {
      areaF.innerHTML = '';
      qiyuLiufangSelecting = true;
      render();
      refreshPlayerCards();
      checkNoValidTarget();
    };
    areaF.appendChild(liufangBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      qiyuLiufangSelecting = false;
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuJiebanWanle', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const jiebanBtn = document.createElement('button');
    jiebanBtn.textContent = '结伴';
    jiebanBtn.className = 'jail-btn';
    jiebanBtn.onclick = () => {
      areaF.innerHTML = '';
      qiyuJiebanWanleSelecting = true;
      render();
      refreshPlayerCards();
      checkNoValidTarget();
    };
    areaF.appendChild(jiebanBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      qiyuJiebanWanleSelecting = false;
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuTuolei', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    qiyuTuoleiSelecting = true;
    render();
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('qiyuFuwufei', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const fuwufeiBtn = document.createElement('button');
    fuwufeiBtn.textContent = '服务费';
    fuwufeiBtn.className = 'jail-btn';
    fuwufeiBtn.onclick = () => {
      fuwufeiBtn.remove();
      qiyuFuwufeiSelecting = true;
      render();
      refreshPlayerCards();
      checkNoValidTarget();
    };
    areaF.appendChild(fuwufeiBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      qiyuFuwufeiSelecting = false;
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuWenjigifwu', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    document.getElementById('areaF').innerHTML = '<button id="noEffectEndBtn" class="jail-btn">结束</button>';
    document.getElementById('noEffectEndBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('endTurn');
    };
  }
});

socket.on('wenjigifwuDice', ({ playerId, dice1, dice2, total }) => {
  wenjigifwuDiceValues = { dice1, dice2 };
  currentDiceValue = total;
  updateGAreaDiceImage(total, playerId === myId);
});

socket.on('liebaoDice', ({ playerId, dice1, dice2, total }) => {
  liebaoDiceValues = { dice1, dice2 };
  currentDiceValue = total;
  updateGAreaDiceImage(total, playerId === myId);
});

socket.on('baizuchongOptions', ({ options }) => {
  const optionLabels = { zhi1: '掷1', zhixiaodian: '掷小点', dianshu1: '点数+1', zaidong: '再动1次' };
  const areaF = document.getElementById('areaF');
  if (!areaF) return;
  areaF.innerHTML = options.map(o => `<button class="jail-btn" onclick="socket.emit('baizuchongSelect',{option:'${o}'});document.getElementById('areaF').innerHTML='';">${optionLabels[o] || o}</button>`).join('');
});

socket.on('baizuchongDiceReady', () => {
  socket.emit('rollDice', 0);
});

socket.on('xixuewenOverlay', ({ ownerName, ownerColor }) => {
  showBottomBarOverlay('/drawable/chongwu/14.png');
});

socket.on('xixuewenOverlayClose', () => {
  hideBottomBarOverlay();
});

socket.on('xixuewenTck', ({ ownerId, ownerName, ownerColor }) => {
  showTck('/drawable/chongwu/14.png', `${coloredName(ownerName, ownerColor)}的吸血蚊正在吸血，请选择：`, [
    { label: '给1', callback: () => { socket.emit('xixuewenChoice', { choice: 'give1', ownerId }); } },
    { label: '-4判小点令翻面', callback: () => { socket.emit('xixuewenChoice', { choice: 'judge', ownerId }); } },
    { label: '给6令其翻面', callback: () => { socket.emit('xixuewenChoice', { choice: 'give4flip', ownerId }); } }
  ]);
});

socket.on('chameleonChooseDice', () => {
  showDiceSelectInF(1, 6, (diceValue) => {
    socket.emit('chameleonDiceSelect', { diceValue });
  });
});

socket.on('hepingxiongmaoTck', ({ propertyName, ownerName, ownerColor, propertyOwnerId }) => {
  showTck('/drawable/chongwu/16.png', `是否用和平熊猫交换${coloredName(ownerName, ownerColor)}的${propertyName}？`, [
    { label: '使用', callback: () => { socket.emit('hepingxiongmaoResponse', { use: true, propertyName, propertyOwnerId }); } },
    { label: '不用', danger: true, callback: () => { socket.emit('hepingxiongmaoResponse', { use: false, propertyName, propertyOwnerId }); } }
  ]);
});

socket.on('baizuchongClearF', () => {
  document.getElementById('areaF').innerHTML = '';
});

socket.on('qiyuTanwu', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const tanwuBtn = document.createElement('button');
    tanwuBtn.textContent = '贪污';
    tanwuBtn.className = 'jail-btn';
    tanwuBtn.onclick = () => {
      tanwuBtn.remove();
      socket.emit('qiyuTanwuConfirm');
    };
    areaF.appendChild(tanwuBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuYunshi', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const freezeBtn = document.createElement('button');
    freezeBtn.textContent = '冻结25';
    freezeBtn.className = 'jail-btn';
    freezeBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('qiyuYunshiFreeze');
      document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
      document.getElementById('endTurnBtn').onclick = () => {
        document.getElementById('areaF').innerHTML = '';
        socket.emit('endTurn');
      };
    };
    areaF.appendChild(freezeBtn);
    const minusBtn = document.createElement('button');
    minusBtn.textContent = '-10';
    minusBtn.className = 'jail-btn';
    minusBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('qiyuYunshiMinus');
      document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
      document.getElementById('endTurnBtn').onclick = () => {
        document.getElementById('areaF').innerHTML = '';
        socket.emit('endTurn');
      };
    };
    areaF.appendChild(minusBtn);
  }
});

socket.on('qiyuZhiboShuijiao', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const shuijiaoBtn = document.createElement('button');
    shuijiaoBtn.textContent = '睡觉';
    shuijiaoBtn.className = 'jail-btn';
    shuijiaoBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('qiyuZhiboShuijiaoConfirm');
      document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
      document.getElementById('endTurnBtn').onclick = () => {
        document.getElementById('areaF').innerHTML = '';
        socket.emit('endTurn');
      };
    };
    areaF.appendChild(shuijiaoBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuYanhui', ({ playerId, playerName, playerColor, qiyu }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const yanhuiBtn = document.createElement('button');
    yanhuiBtn.textContent = '宴会';
    yanhuiBtn.className = 'jail-btn';
    yanhuiBtn.onclick = () => {
      yanhuiBtn.remove();
      socket.emit('qiyuYanhuiConfirm');
    };
    areaF.appendChild(yanhuiBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuAiwuJiwu', ({ playerId, playerName, playerColor, qiyu, hasProperty }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const aiwuBtn = document.createElement('button');
    aiwuBtn.textContent = '爱屋';
    aiwuBtn.className = 'jail-btn';
    aiwuBtn.onclick = () => {
      aiwuBtn.remove();
      if (!hasProperty) {
        $('areaE').innerHTML = '没有合适的地产';
        fitAreaEText();
      } else {
        qiyuAiwuJiwuSelecting = true;
        render();
      }
    };
    areaF.appendChild(aiwuBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      qiyuAiwuJiwuSelecting = false;
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuTudijianbing', ({ playerId, playerName, playerColor, qiyu, canExecute }) => {
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  if (playerId === myId) {
    const areaF = document.getElementById('areaF');
    areaF.innerHTML = '';
    const jianbingBtn = document.createElement('button');
    jianbingBtn.textContent = '兼并';
    jianbingBtn.className = 'jail-btn';
    jianbingBtn.onclick = () => {
      const myProperties = board.filter(s => s.isProperty && s.owner === myId);
      const othersWithProperty = players.filter(p => p.id !== myId && !p.bankrupt && board.some(s => s.isProperty && s.owner === p.id));
      if (myProperties.length === 0 || othersWithProperty.length === 0) {
        $('areaE').innerHTML = '没有合适的地产';
        fitAreaEText();
        jianbingBtn.remove();
        return;
      }
      areaF.innerHTML = '';
      qiyuTudijianbingSelectingTarget = true;
      render();
      refreshPlayerCards();
      checkNoValidTarget();
    };
    areaF.appendChild(jianbingBtn);
    const endBtn = document.createElement('button');
    endBtn.textContent = '结束';
    endBtn.className = 'jail-btn';
    endBtn.onclick = () => {
      qiyuTudijianbingSelectingTarget = false;
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    areaF.appendChild(endBtn);
  }
});

socket.on('qiyuTudijianbingSelectProperty', ({ initiatorId, targetId, initiatorName, targetName }) => {
  const me = players.find(p => p.id === myId);
  if (!me) return;
  
  const isInitiator = myId === initiatorId;
  const isTarget = myId === targetId;
  
  if (isInitiator || isTarget) {
    $('areaE').innerHTML = `请选择你要暗置的地产`;
    fitAreaEText();
    qiyuTudijianbingSelectingProperty = true;
    render();
  }
});

socket.on('qiyuTudijianbingWaiting', ({ waitingFor }) => {
  const waitingPlayer = players.find(p => p.id === waitingFor);
  $('areaE').innerHTML = `等待${waitingPlayer?.name || '对方'}选择地产...`;
  fitAreaEText();
  qiyuTudijianbingSelectingProperty = false;
  render();
});

socket.on('qiyuTudijianbingEnd', () => {
  qiyuTudijianbingSelectingTarget = false;
  qiyuTudijianbingSelectingProperty = false;
  render();
  const cur = players[currentPlayerIdx];
  if (cur?.id === myId) {
    document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    document.getElementById('endTurnBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      socket.emit('endTurn');
    };
  }
});

let qiyuXiaolicangdaoSelectingProp = false;
let qiyuXiaolicangdaoSelectingTarget = false;
let qiyuXiaduSelectingTarget = false;
let qiyuJietouDouruSelectingTarget = false;
let qiyuBanzhuanDarenSelectingProp = false;
let qiyuAnduchengcangSelectingTarget = false;
let qiyuAnduchengcangSelectingProp = false;
let qiyuQiankundanayiSelectingTarget = false;

socket.on('qiyuXiaolicangdao', ({ playerId, playerName, playerColor, qiyu, hasProperty }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="qiyuXiaolicangdaoBtn" class="jail-btn">藏刀</button><button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('qiyuXiaolicangdaoBtn').onclick = () => {
    document.getElementById('qiyuXiaolicangdaoBtn').remove();
    if (!hasProperty) {
      $('areaE').innerHTML = '没有合适的地产';
      fitAreaEText();
    } else {
      areaF.innerHTML = '';
      $('areaE').innerHTML = '请选择你要给出的地产';
      qiyuXiaolicangdaoSelectingProp = true;
      render();
    }
  };
  document.getElementById('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

socket.on('qiyuXiaolicangdaoSelectTarget', ({ playerId, targets }) => {
  if (myId !== playerId) return;
  qiyuXiaolicangdaoSelectingProp = false;
  qiyuXiaolicangdaoSelectingTarget = true;
  $('areaE').innerHTML = '请选择目标玩家';
  fitAreaEText();
  render();
  refreshPlayerCards();
  checkNoValidTarget();
});

socket.on('qiyuXiadu', ({ playerId, playerName, playerColor, qiyu, hasTarget }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="qiyuXiaduBtn" class="jail-btn">下毒</button><button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('qiyuXiaduBtn').onclick = () => {
    if (!hasTarget) {
      $('areaE').innerHTML = '没有合适的目标';
      areaF.innerHTML = `<button id="endTurnBtn" class="jail-btn">结束</button>`;
      document.getElementById('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
      return;
    }
    areaF.innerHTML = '';
    $('areaE').innerHTML = '请选择目标玩家';
    qiyuXiaduSelectingTarget = true;
    render();
  };
  document.getElementById('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

socket.on('qiyuFanzhuanStart', ({ currentPlayerId, currentPlayerName, currentPlayerColor }) => {
  const areaF = document.getElementById('areaF');
  if (myId === currentPlayerId) {
    areaF.innerHTML = `<button class="jail-btn" onclick="socket.emit('qiyuFanzhuanChoice', { choice: '-10' });">-10</button><button class="jail-btn" onclick="socket.emit('qiyuFanzhuanChoice', { choice: '+10' });">+10</button>`;
  } else {
    areaF.innerHTML = `<button class="jail-btn" onclick="socket.emit('qiyuFanzhuanChoice', { choice: '-5' });">-5</button><button class="jail-btn" onclick="socket.emit('qiyuFanzhuanChoice', { choice: '反转' });">反转</button>`;
  }
});

socket.on('qiyuFanzhuanChoiceMade', () => {
  document.getElementById('areaF').innerHTML = '';
});

socket.on('baozhengStart', ({ currentPlayerId, currentPlayerName, currentPlayerColor }) => {
  const areaF = document.getElementById('areaF');
  if (myId === currentPlayerId) return;
  areaF.innerHTML = `<button class="jail-btn" onclick="socket.emit('baozhengChoice', { choice: '反抗' });">反抗</button><button class="jail-btn" onclick="socket.emit('baozhengChoice', { choice: '进贡' });">进贡</button>`;
});

socket.on('baozhengChoiceMade', () => {
  document.getElementById('areaF').innerHTML = '';
});

let daoyingSelectingTarget = false;

socket.on('daoyingStart', ({ currentPlayerId, currentPlayerName, currentPlayerColor, hasTarget }) => {
  const areaF = document.getElementById('areaF');
  if (myId !== currentPlayerId) return;
  areaF.innerHTML = `<button class="jail-btn" onclick="socket.emit('daoyingChoice', { choice: '-7' });">-7</button><button class="jail-btn" onclick="socket.emit('daoyingChoice', { choice: '到监狱' });">到监狱</button><button class="jail-btn" onclick="socket.emit('daoyingChoice', { choice: '工资-3' });">工资-3</button>`;
});

socket.on('daoyingChoiceMade', () => {
  document.getElementById('areaF').innerHTML = '';
});

socket.on('daoyingSelectTarget', ({ currentPlayerId, currentPlayerName, currentPlayerColor }) => {
  if (myId !== currentPlayerId) return;
  daoyingSelectingTarget = true;
  $('areaE').innerHTML = '请选择目标玩家';
  render();
  refreshPlayerCards();
  checkNoValidTarget();
});

socket.on('jiandieShowPanel', ({ currentPlayerId, currentPlayerName, currentPlayerColor, targetAId, targetAName, targetAColor, targetBId, targetBName, targetBColor }) => {
  if (myId !== currentPlayerId) return;
  
  const hArea = document.getElementById('hArea');
  if (!hArea) return;
  
  const panel = document.createElement('div');
  panel.id = 'jiandiePanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:150;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0f1a3a;gap:10px;pointer-events:auto;';
  
  const img = document.createElement('img');
  img.src = '/drawable/jiyu/jiandie.jpg';
  img.style.cssText = 'width:clamp(100px,25vw,160px);height:clamp(100px,25vw,160px);object-fit:contain;border-radius:8px;';
  panel.appendChild(img);
  
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:20px;width:90%;justify-content:center;';
  
  const calcContainer = document.createElement('div');
  calcContainer.id = 'jiandieCalcContainer';
  calcContainer.style.cssText = 'display:none;flex-direction:column;align-items:center;gap:6px;';
  
  let sideAConfirmed = false, sideBConfirmed = false;
  let sideAValue = 0, sideBValue = 0;
  
  const createNameDiv = (targetName, targetColor, side) => {
    const nameDiv = document.createElement('div');
    nameDiv.id = `jiandieName_${side}`;
    nameDiv.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;padding:6px 12px;border-radius:6px;background:rgba(255,255,255,0.1);pointer-events:auto;';
    nameDiv.innerHTML = `<span style="color:#fff;font-size:clamp(16px,4vw,26px);font-weight:bold;">${targetName}</span>`;
    
    nameDiv.onclick = () => {
      if ((side === 'A' && sideAConfirmed) || (side === 'B' && sideBConfirmed)) return;
      showCalcFor(side, targetName, targetColor);
      nameDiv.style.cursor = 'default';
      nameDiv.style.background = 'rgba(255,255,255,0.05)';
    };
    
    return nameDiv;
  };
  
  const showCalcFor = (side, targetName, targetColor) => {
    calcContainer.style.display = 'flex';
    calcContainer.innerHTML = '';
    
    const nameLabel = document.createElement('div');
    nameLabel.style.cssText = 'display:flex;align-items:center;gap:4px;';
    nameLabel.innerHTML = `<span style="color:#fff;font-size:clamp(14px,3.5vw,22px);font-weight:bold;">${targetName}</span>`;
    calcContainer.appendChild(nameLabel);
    
    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;align-items:center;gap:4px;';
    
    const numInput = document.createElement('input');
    numInput.type = 'text';
    numInput.id = `jiandieNumber_${side}`;
    numInput.value = '0';
    numInput.readOnly = true;
    numInput.style.cssText = 'width:70px;text-align:center;font-size:22px;background:#fff;color:#000;border:1px solid #666;padding:6px;border-radius:4px;font-weight:bold;';
    inputRow.appendChild(numInput);
    
    const clearBtn = document.createElement('button');
    clearBtn.className = 'jiandie-calc-btn';
    clearBtn.textContent = '清零';
    clearBtn.style.cssText = 'color:transparent;';
    clearBtn.disabled = true;
    inputRow.appendChild(clearBtn);
    
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'jiandie-calc-btn';
    confirmBtn.textContent = '确定';
    confirmBtn.style.cssText = 'color:transparent;';
    confirmBtn.disabled = true;
    inputRow.appendChild(confirmBtn);
    
    calcContainer.appendChild(inputRow);
    
    const numRow1 = document.createElement('div');
    numRow1.style.cssText = 'display:flex;gap:4px;';
    [1,2,3,4,5].forEach(v => {
      const btn = document.createElement('button');
      btn.className = `jiandie-calc-btn jiandie-num-${side}`;
      btn.dataset.val = String(v);
      btn.textContent = String(v);
      numRow1.appendChild(btn);
    });
    calcContainer.appendChild(numRow1);
    
    const numRow2 = document.createElement('div');
    numRow2.style.cssText = 'display:flex;gap:4px;';
    [6,7,8,9,0].forEach(v => {
      const btn = document.createElement('button');
      btn.className = `jiandie-calc-btn jiandie-num-${side}`;
      btn.dataset.val = String(v);
      btn.textContent = String(v);
      numRow2.appendChild(btn);
    });
    calcContainer.appendChild(numRow2);
    
    const style = document.createElement('style');
    style.textContent = `.jiandie-calc-btn { min-width:36px;height:36px;background:#333;color:#fff;border:none;border-radius:6px;font-size:16px;cursor:pointer;padding:0 8px;pointer-events:auto; } .jiandie-calc-btn:hover { background:#555; } .jiandie-calc-btn:disabled { background:#333 !important; color:transparent !important; opacity:1 !important; }`;
    calcContainer.appendChild(style);
    
    let currentValue = '0';
    
    const updateDisplay = () => {
      numInput.value = currentValue;
      if (currentValue === '0') {
        clearBtn.disabled = true;
        clearBtn.style.color = 'transparent';
        confirmBtn.disabled = true;
        confirmBtn.style.color = 'transparent';
      } else {
        clearBtn.disabled = false;
        clearBtn.style.color = '#fff';
        confirmBtn.disabled = false;
        confirmBtn.style.color = '#fff';
      }
    };
    
    calcContainer.querySelectorAll(`.jiandie-num-${side}`).forEach(btn => {
      btn.onclick = () => {
        const val = btn.dataset.val;
        if (currentValue === '0') currentValue = val;
        else currentValue += val;
        updateDisplay();
      };
    });
    
    clearBtn.onclick = () => {
      currentValue = '0';
      updateDisplay();
    };
    
    confirmBtn.onclick = () => {
      const value = parseInt(currentValue) || 0;
      if (side === 'A') { sideAConfirmed = true; sideAValue = value; }
      else { sideBConfirmed = true; sideBValue = value; }
      
      const nameEl = document.getElementById(`jiandieName_${side}`);
      if (nameEl) {
        const nameSpan = nameEl.querySelector('span:last-child');
        if (nameSpan) nameSpan.textContent = `${targetName}：${value}`;
      }
      
      calcContainer.style.display = 'none';
      
      if (sideAConfirmed && sideBConfirmed) {
        if (sideAValue === sideBValue) {
          sideAConfirmed = false;
          sideBConfirmed = false;
          sideAValue = 0;
          sideBValue = 0;
          const nameA = document.getElementById('jiandieName_A');
          if (nameA) { const s = nameA.querySelector('span:last-child'); if (s) s.textContent = targetAName; }
          const nameB = document.getElementById('jiandieName_B');
          if (nameB) { const s = nameB.querySelector('span:last-child'); if (s) s.textContent = targetBName; }
          const errMsg = document.getElementById('jiandieEqualMsg');
          if (errMsg) errMsg.style.display = 'block';
          nameA.style.cursor = 'pointer';
          nameA.style.background = 'rgba(255,255,255,0.1)';
          nameB.style.cursor = 'pointer';
          nameB.style.background = 'rgba(255,255,255,0.1)';
          return;
        }
        socket.emit('jiandieAmountConfirm', { amountA: sideAValue, amountB: sideBValue });
      }
    };
  };
  
  const nameA = createNameDiv(targetAName, targetAColor, 'A');
  row.appendChild(nameA);
  const nameB = createNameDiv(targetBName, targetBColor, 'B');
  row.appendChild(nameB);
  
  panel.appendChild(row);
  panel.appendChild(calcContainer);
  
  const equalMsg = document.createElement('div');
  equalMsg.id = 'jiandieEqualMsg';
  equalMsg.style.cssText = 'color:#ff6b6b;font-size:clamp(14px,3.5vw,22px);display:none;';
  equalMsg.textContent = '两个数字不能相等';
  panel.appendChild(equalMsg);
  
  hArea.appendChild(panel);
});

socket.on('jiandiePanelEnd', () => {
  const panel = document.getElementById('jiandiePanel');
  if (panel) panel.remove();
});

socket.on('jiandieChoice', ({ targetName, targetColor }) => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button class="jail-btn" onclick="socket.emit('jiandieChoiceConfirm', { choice: '收下' }); document.getElementById('areaF').innerHTML='';">收下</button><button class="jail-btn" onclick="socket.emit('jiandieChoiceConfirm', { choice: '退回' }); document.getElementById('areaF').innerHTML='';">退回</button>`;
});

socket.on('jiandieChoiceMade', ({ playerId, playerName, choice }) => {
});

socket.on('jiandieEnd', () => {
  const panel = document.getElementById('jiandiePanel');
  if (panel) panel.remove();
});

socket.on('xianzhiStart', ({ playerId, playerName, playerColor, jiyus }) => {
  if (myId !== playerId) return;
  
  const hArea = document.getElementById('hArea');
  if (!hArea) return;
  
  const panel = document.createElement('div');
  panel.id = 'xianzhiPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:150;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0f1a3a;gap:12px;pointer-events:auto;';
  
  let currentOrder = [0, 1, 2];
  let selectedIdx = null;
  
  const renderPanel = () => {
    panel.innerHTML = '';
    
    const topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex;align-items:center;gap:12px;';
    
    const bgImg = document.createElement('img');
    bgImg.src = '/drawable/jiyu/xianzhi.png';
    bgImg.style.cssText = 'width:clamp(80px,20vw,130px);height:clamp(80px,20vw,130px);object-fit:contain;border-radius:8px;';
    topRow.appendChild(bgImg);
    
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '确定';
    confirmBtn.style.cssText = 'padding:10px 30px;font-size:clamp(20px,4vw,28px);background:#000;color:#fff;border:none;border-radius:8px;cursor:pointer;pointer-events:auto;';
    confirmBtn.onclick = () => {
      socket.emit('xianzhiConfirm', { order: currentOrder });
    };
    topRow.appendChild(confirmBtn);
    
    panel.appendChild(topRow);
    
    currentOrder.forEach((jiyuIdx, displayIdx) => {
      const row = document.createElement('div');
      row.style.cssText = `background:#111;color:#fff;padding:10px 20px;border-radius:8px;font-size:clamp(16px,4vw,24px);cursor:pointer;border:2px solid ${selectedIdx === displayIdx ? '#fff' : 'transparent'};min-width:60%;text-align:center;pointer-events:auto;`;
      row.innerHTML = `<span style="color:#aaa;">${displayIdx + 1}.</span> ${jiyus[jiyuIdx].name}：${jiyus[jiyuIdx].desc}`;
      row.onclick = () => {
        if (selectedIdx === null) {
          selectedIdx = displayIdx;
        } else {
          const temp = currentOrder[selectedIdx];
          currentOrder[selectedIdx] = currentOrder[displayIdx];
          currentOrder[displayIdx] = temp;
          selectedIdx = null;
        }
        renderPanel();
      };
      panel.appendChild(row);
    });
  };
  
  renderPanel();
  hArea.appendChild(panel);
});

socket.on('xianzhiEnd', () => {
  const panel = document.getElementById('xianzhiPanel');
  if (panel) panel.remove();
});

socket.on('tuisuanStart', ({ currentPlayerId, currentPlayerName, currentPlayerColor, targetPlayerId, targetPlayerName, targetPlayerColor, numbers }) => {
  const hArea = document.getElementById('hArea');
  if (!hArea) return;
  
  const isPlayer = (myId === currentPlayerId || myId === targetPlayerId);
  
  const panel = document.createElement('div');
  panel.id = 'tuisuanPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:150;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1a2a4a;gap:clamp(4px,1vh,10px);pointer-events:auto;overflow:hidden;padding:clamp(4px,1vh,12px);';
  
  const img = document.createElement('img');
  img.src = '/drawable/jiyu/tuisuan.jpg';
  img.style.cssText = 'width:clamp(100px,25vw,160px);height:clamp(100px,25vw,160px);object-fit:contain;border-radius:8px;';
  panel.appendChild(img);
  
  const numsDiv = document.createElement('div');
  numsDiv.style.cssText = 'color:#fff;font-size:clamp(24px,6vw,40px);font-weight:bold;text-align:center;letter-spacing:2px;';
  numsDiv.innerHTML = numbers.map(n => `<span style="display:inline-block;letter-spacing:-2px;">${n}</span>`).join('，');
  panel.appendChild(numsDiv);
  
  if (isPlayer) {
    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;align-items:center;gap:clamp(4px,1vw,8px);flex-wrap:wrap;justify-content:center;';
    
    const numInput = document.createElement('input');
    numInput.type = 'text';
    numInput.id = 'tuisuanNumber';
    numInput.value = '0';
    numInput.readOnly = true;
    numInput.style.cssText = 'width:clamp(80px,20vw,120px);text-align:center;font-size:clamp(18px,4vh,28px);background:#fff;color:#000;border:1px solid #666;padding:clamp(4px,1vh,8px);border-radius:4px;font-weight:bold;';
    inputRow.appendChild(numInput);
    
    const clearBtn = document.createElement('button');
    clearBtn.className = 'tuisuan-calc-btn';
    clearBtn.textContent = '清零';
    clearBtn.style.cssText = 'color:transparent;';
    clearBtn.disabled = true;
    inputRow.appendChild(clearBtn);
    
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'tuisuan-calc-btn';
    confirmBtn.textContent = '确定';
    confirmBtn.style.cssText = 'color:transparent;';
    confirmBtn.disabled = true;
    inputRow.appendChild(confirmBtn);
    
    panel.appendChild(inputRow);
    
    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;gap:clamp(4px,1vw,8px);flex-wrap:wrap;justify-content:center;';
    [1,2,3,4,5].forEach(v => {
      const btn = document.createElement('button');
      btn.className = 'tuisuan-calc-btn tuisuan-num';
      btn.dataset.val = String(v);
      btn.textContent = String(v);
      row1.appendChild(btn);
    });
    panel.appendChild(row1);
    
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:clamp(4px,1vw,8px);flex-wrap:wrap;justify-content:center;';
    [6,7,8,9,0].forEach(v => {
      const btn = document.createElement('button');
      btn.className = 'tuisuan-calc-btn tuisuan-num';
      btn.dataset.val = String(v);
      btn.textContent = String(v);
      row2.appendChild(btn);
    });
    panel.appendChild(row2);
    
    const style = document.createElement('style');
    style.textContent = `.tuisuan-calc-btn { min-width:clamp(36px,9vw,50px);height:clamp(36px,9vw,50px);background:#333;color:#fff;border:none;border-radius:clamp(4px,1vh,8px);font-size:clamp(14px,3.5vw,20px);cursor:pointer;padding:0 clamp(4px,1vw,12px);pointer-events:auto; } .tuisuan-calc-btn:hover { background:#555; } .tuisuan-calc-btn:disabled { background:#333 !important; color:transparent !important; opacity:1 !important; }`;
    panel.appendChild(style);
    
    let currentValue = '0';
    const updateDisplay = () => {
      numInput.value = currentValue;
      if (currentValue === '0') {
        clearBtn.disabled = true;
        clearBtn.style.color = 'transparent';
        confirmBtn.disabled = true;
        confirmBtn.style.color = 'transparent';
      } else {
        clearBtn.disabled = false;
        clearBtn.style.color = '#fff';
        confirmBtn.disabled = false;
        confirmBtn.style.color = '#fff';
      }
    };
    
    panel.querySelectorAll('.tuisuan-num').forEach(btn => {
      btn.onclick = () => {
        const val = btn.dataset.val;
        if (currentValue === '0') {
          currentValue = val;
        } else {
          currentValue += val;
        }
        updateDisplay();
      };
    });
    
    clearBtn.onclick = () => {
      currentValue = '0';
      updateDisplay();
    };
    
    confirmBtn.onclick = () => {
      const value = parseInt(currentValue) || 0;
      socket.emit('tuisuanConfirm', { guess: value });
      panel.innerHTML = '';
      const waitMsg = document.createElement('div');
      waitMsg.style.cssText = 'color:#aaa;font-size:clamp(20px,5vw,32px);';
      waitMsg.textContent = '请等待对方确定';
      panel.appendChild(waitMsg);
    };
  } else {
  }
  
  hArea.appendChild(panel);
});

socket.on('tuisuanPlayerConfirmed', ({ playerId, playerName }) => {
});

socket.on('tuisuanEnd', ({ W, winnerName, winnerColor, winnerGuess, loserName, loserColor, loserGuess }) => {
  const panel = document.getElementById('tuisuanPanel');
  if (panel) panel.remove();
  $('areaE').innerHTML = `最大数字为${W}，${coloredName(winnerName, winnerColor)}猜测${winnerGuess}胜+13，${coloredName(loserName, loserColor)}猜测${loserGuess}败-13`;
  fitAreaEText();
});

socket.on('cunqianStart', ({ playerId, playerName, playerColor }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button class="jail-btn" onclick="socket.emit('cunqianConfirm');">存钱</button><button class="jail-btn" onclick="doEndTurn();">结束</button>`;
});

socket.on('cunqianConfirmed', ({ playerId }) => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
  refreshPlayerCards();
});

socket.on('cunqianRoundUpdate', ({ playerId, rounds }) => {
  refreshPlayerCards();
});

socket.on('cunqianExpired', ({ playerId }) => {
  refreshPlayerCards();
});

socket.on('dezhouStart', ({ playerId, playerName, playerColor }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button class="jail-btn" onclick="document.getElementById('areaF').innerHTML='';socket.emit('dezhouConfirm');">德州</button><button class="jail-btn" onclick="doEndTurn();">结束</button>`;
});

let selectingLunciTarget = false;

let selectingJiandieTarget = false;
let jiandieSelectedFirst = null;

let caboRow3Name = '';
let caboRow3Color = '';
let caboRow3Cards = [];
let caboRow4Name = '';
let caboRow4Color = '';
let caboRow4Cards = [];
let caboMyRow = 0;
let caboIsCaller = false;
let caboCalled = false;
let caboCurrentTurnId = null;
let caboPeekedIndices = [];
let caboDrawnCard = null;
let caboActionPhase = null;
let caboDiscardTop = null;
let caboMessageText = '请查看自己的2张牌';
let caboPeekDone = false;
let caboWhiteFrames = { row3: [], row4: [] };
let caboSwapMultiIndices = [];
let caboDrawExchangeIndices = [];
let caboFaceUpMap = { row3: [], row4: [] };
let caboPeekOtherValue = null;
let caboPeekOtherIndex = -1;
let caboSettled = false;
let caboRow3Sum = 0;
let caboRow4Sum = 0;

function caboCreatePanel() {
  let existing = document.getElementById('caboPanel');
  if (existing) existing.remove();
  const s1Area = document.getElementById('s1Area');
  if (!s1Area) return;
  const rect = s1Area.getBoundingClientRect();
  const panel = document.createElement('div');
  panel.id = 'caboPanel';
  panel.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px;z-index:200;background:url(/drawable/bj6.jpg) center/cover no-repeat;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px;box-sizing:border-box;overflow:hidden;`;
  document.body.appendChild(panel);
  return panel;
}

function caboGetMyCards() {
  return caboMyRow === 3 ? caboRow3Cards : caboRow4Cards;
}

function caboGetOtherCards() {
  return caboMyRow === 3 ? caboRow4Cards : caboRow3Cards;
}

function caboRender() {
  const panel = document.getElementById('caboPanel');
  if (!panel) return;
  const isMyTurn = caboCurrentTurnId === myId;
  const cardH = 'clamp(60px,14vw,90px)';
  const imgSize = 'clamp(60px,14vw,90px)';
  const fontSize = 'clamp(16px,4vw,26px)';
  const nameFontSize = 'clamp(14px,3vw,20px)';
  const nameW = 'clamp(60px,18vw,100px)';
  const textColor = '#000';
  let html = '';
  html += '<div style="display:flex;justify-content:space-around;align-items:center;width:100%;flex-shrink:0;padding:2px 0;">';
  const canAct = isMyTurn && caboActionPhase === null && caboPeekDone;
  const caboClickable = (canAct && !caboCalled) ? 'cursor:pointer;' : 'cursor:default;opacity:0.6;';
  const deckClickable = canAct ? 'cursor:pointer;' : 'cursor:default;opacity:0.6;';
  const discardClickable = (isMyTurn && caboPeekDone && (caboActionPhase === 'drawn' || (caboActionPhase === null && caboDiscardTop !== null))) ? 'cursor:pointer;' : 'cursor:default;opacity:0.6;';
  html += `<div style="text-align:center;${caboClickable}" id="caboCallBtn"><div style="color:${textColor};font-size:${fontSize};">卡波</div><img src="/drawable/jiyu/cabo/cabo.png" style="width:${imgSize};height:${imgSize};object-fit:contain;"></div>`;
  const deckSrc = caboDrawnCard ? `/drawable/jiyu/cabo/${caboDrawnCard}.png` : '/drawable/jiyu/cabo/kabei.png';
  html += `<div style="text-align:center;${deckClickable}" id="caboDeckBtn"><div style="color:${textColor};font-size:${fontSize};">抽牌堆</div><img src="${deckSrc}" style="width:${imgSize};height:${imgSize};object-fit:contain;"></div>`;
  html += `<div style="text-align:center;${discardClickable}" id="caboDiscardArea"><div style="color:${textColor};font-size:${fontSize};">弃牌堆</div>`;
  if (caboDiscardTop !== null) {
    html += `<img src="/drawable/jiyu/cabo/${caboDiscardTop}.png" style="width:${imgSize};height:${imgSize};object-fit:contain;">`;
  } else {
    html += `<div style="width:${imgSize};height:${imgSize};"></div>`;
  }
  html += '</div></div>';
  const skipBtnVisible = isMyTurn && caboActionPhase === 'swapMulti' && caboSwapMultiIndices.length === 0;
  const confirmBtnVisible = isMyTurn && (caboActionPhase === 'drawn' || caboActionPhase === 'takeDiscard') && caboDrawExchangeIndices.length >= 1;
  const skipBtn = `<div id="caboSkipSwap" style="color:${textColor};font-size:${fontSize};cursor:pointer;padding:4px 16px;border:2px solid #2ecc71;border-radius:4px;white-space:nowrap;${skipBtnVisible ? '' : 'visibility:hidden;'}">放弃交换</div>`;
  const confirmBtn = `<div id="caboDrawConfirm" style="color:${textColor};font-size:${fontSize};cursor:pointer;padding:4px 16px;border:2px solid #2ecc71;border-radius:4px;white-space:nowrap;${confirmBtnVisible ? '' : 'visibility:hidden;'}">确认交换</div>`;
  html += `<div style="color:${textColor};font-size:${fontSize};text-align:center;padding:2px 0;flex-shrink:0;display:flex;align-items:center;justify-content:center;" id="caboMessage">${caboMessageText}</div>`;
  
  const row3Peekable = caboMyRow === 3 && !caboPeekDone;
  const row3IsMyRow = caboMyRow === 3;
  const row3IsOtherRow = caboMyRow === 4;
  const row3MyCardClickable = isMyTurn && !caboSettled && row3IsMyRow && (
    caboActionPhase === 'drawn' || caboActionPhase === 'takeDiscard' ||
    caboActionPhase === 'peekOwn' || caboActionPhase === 'swapMulti'
  );
  const row3OtherCardClickable = isMyTurn && !caboSettled && row3IsOtherRow && (
    caboActionPhase === 'peekOther' ||
    (caboActionPhase === 'swapMulti' && caboSwapMultiIndices.length >= 1)
  );
  const row3CanClick = row3Peekable || row3MyCardClickable || row3OtherCardClickable;

  html += '<div style="display:flex;align-items:center;padding:2px 0;flex-shrink:0;gap:2px;width:100%;">';
  const row3ScoreHtml = caboSettled ? `<div style="color:${textColor};font-size:${nameFontSize};text-align:center;">${caboRow3Sum}</div>` : '';
  html += `<div style="display:flex;flex-direction:column;width:${nameW};flex-shrink:0;"><div style="display:flex;align-items:center;gap:2px;"><span style="color:${textColor};font-size:${nameFontSize};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${caboRow3Name}</span></div>${row3ScoreHtml}</div>`;
  for (let i = 0; i < caboRow3Cards.length; i++) {
    const isPeeked = caboMyRow === 3 && caboPeekedIndices.includes(i);
    const isPeekOther = caboPeekOtherIndex === i && caboMyRow === 4 && caboPeekOtherValue !== null;
    const isFaceUp = caboFaceUpMap.row3.includes(i);
    const showFace = caboSettled || (isPeeked && caboRow3Cards[i] !== undefined && caboRow3Cards[i] > 0) || isPeekOther || isFaceUp;
    const isShrink = caboWhiteFrames.row3.includes(i);
    const isSwapMultiSel = caboActionPhase === 'swapMulti' && caboMyRow === 3 && caboSwapMultiIndices.includes(i);
    const isDrawExchangeSel = (caboActionPhase === 'drawn' || caboActionPhase === 'takeDiscard') && caboMyRow === 3 && caboDrawExchangeIndices.includes(i);
    const faceValue = isPeekOther ? caboPeekOtherValue : caboRow3Cards[i];
    const isEmpty = caboRow3Cards[i] === -1;
    const src = isEmpty ? '' : (showFace && faceValue !== undefined && faceValue > 0 ? `/drawable/jiyu/cabo/${faceValue}.png` : '/drawable/jiyu/cabo/kabei.png');
    const border = isSwapMultiSel ? 'border:2px solid #f1c40f;' : isDrawExchangeSel ? 'border:2px solid #2ecc71;' : '';
    const shrink = isShrink ? 'transform:scale(0.8);' : '';
    const clickStyle = (row3CanClick && !isEmpty) ? 'cursor:pointer;' : 'cursor:default;opacity:0.6;';
    if (isEmpty) {
      html += `<div style="flex:1;min-width:0;height:${cardH};${border}${shrink}" class="cabo-row3-card" data-index="${i}"></div>`;
    } else {
      html += `<img src="${src}" style="flex:1;min-width:0;height:${cardH};object-fit:contain;transition:transform 0.2s;${border}${shrink}${clickStyle}" class="cabo-row3-card" data-index="${i}">`;
    }
  }
  html += '</div>';
  
  const row4Peekable = caboMyRow === 4 && !caboPeekDone;
  const row4IsMyRow = caboMyRow === 4;
  const row4IsOtherRow = caboMyRow === 3;
  const row4MyCardClickable = isMyTurn && !caboSettled && row4IsMyRow && (
    caboActionPhase === 'drawn' || caboActionPhase === 'takeDiscard' ||
    caboActionPhase === 'peekOwn' || caboActionPhase === 'swapMulti'
  );
  const row4OtherCardClickable = isMyTurn && !caboSettled && row4IsOtherRow && (
    caboActionPhase === 'peekOther' ||
    (caboActionPhase === 'swapMulti' && caboSwapMultiIndices.length >= 1)
  );
  const row4CanClick = row4Peekable || row4MyCardClickable || row4OtherCardClickable;

  html += '<div style="display:flex;align-items:center;padding:2px 0;flex-shrink:0;gap:2px;width:100%;">';
  const row4ScoreHtml = caboSettled ? `<div style="color:${textColor};font-size:${nameFontSize};text-align:center;">${caboRow4Sum}</div>` : '';
  html += `<div style="display:flex;flex-direction:column;width:${nameW};flex-shrink:0;"><div style="display:flex;align-items:center;gap:2px;"><span style="color:${textColor};font-size:${nameFontSize};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${caboRow4Name}</span></div>${row4ScoreHtml}</div>`;
  for (let i = 0; i < caboRow4Cards.length; i++) {
    const isPeeked = caboMyRow === 4 && caboPeekedIndices.includes(i);
    const isPeekOther = caboPeekOtherIndex === i && caboMyRow === 3 && caboPeekOtherValue !== null;
    const isFaceUp = caboFaceUpMap.row4.includes(i);
    const showFace = caboSettled || (isPeeked && caboRow4Cards[i] !== undefined && caboRow4Cards[i] > 0) || isPeekOther || isFaceUp;
    const isShrink = caboWhiteFrames.row4.includes(i);
    const isSwapMultiSel = caboActionPhase === 'swapMulti' && caboMyRow === 4 && caboSwapMultiIndices.includes(i);
    const isDrawExchangeSel = (caboActionPhase === 'drawn' || caboActionPhase === 'takeDiscard') && caboMyRow === 4 && caboDrawExchangeIndices.includes(i);
    const faceValue = isPeekOther ? caboPeekOtherValue : caboRow4Cards[i];
    const isEmpty = caboRow4Cards[i] === -1;
    const src = isEmpty ? '' : (showFace && faceValue !== undefined && faceValue > 0 ? `/drawable/jiyu/cabo/${faceValue}.png` : '/drawable/jiyu/cabo/kabei.png');
    const border = isSwapMultiSel ? 'border:2px solid #f1c40f;' : isDrawExchangeSel ? 'border:2px solid #2ecc71;' : '';
    const shrink = isShrink ? 'transform:scale(0.8);' : '';
    const clickStyle = (row4CanClick && !isEmpty) ? 'cursor:pointer;' : 'cursor:default;opacity:0.6;';
    if (isEmpty) {
      html += `<div style="flex:1;min-width:0;height:${cardH};${border}${shrink}" class="cabo-row4-card" data-index="${i}"></div>`;
    } else {
      html += `<img src="${src}" style="flex:1;min-width:0;height:${cardH};object-fit:contain;transition:transform 0.2s;${border}${shrink}${clickStyle}" class="cabo-row4-card" data-index="${i}">`;
    }
  }
  html += '</div>';
  html += `<div style="display:flex;align-items:center;justify-content:center;padding:8px 0 2px 0;flex-shrink:0;gap:8px;width:100%;">${skipBtn}${confirmBtn}</div>`;
  panel.innerHTML = html;
  caboBindEvents();
}

function caboBindEvents() {
  const closeBtn = $('caboCloseBtn');
  if (closeBtn) {
    closeBtn.onclick = () => {
      const panel = document.getElementById('caboPanel');
      if (panel) panel.remove();
      socket.emit('caboClose');
    };
  }
  const isMyTurn = caboCurrentTurnId === myId;
  const canAct = isMyTurn && caboActionPhase === null && caboPeekDone;
  const clearWhiteFrames = () => { caboWhiteFrames = { row3: [], row4: [] }; };
  const callBtn = $('caboCallBtn');
  if (callBtn) {
    callBtn.onclick = () => {
      if (canAct && !caboCalled) {
        clearWhiteFrames();
        caboSwapMultiIndices = [];
        caboDrawExchangeIndices = [];
        caboRender();
        socket.emit('caboCallCabo');
      }
    };
  }
  const deckBtn = $('caboDeckBtn');
  if (deckBtn) {
    deckBtn.onclick = () => {
      if (canAct) {
        clearWhiteFrames();
        caboSwapMultiIndices = [];
        caboDrawExchangeIndices = [];
        caboRender();
        socket.emit('caboDrawDeck');
      }
    };
  }
  const discardArea = $('caboDiscardArea');
  if (discardArea) {
    discardArea.onclick = () => {
      if (isMyTurn && caboPeekDone) {
        if (caboActionPhase === 'drawn') {
          clearWhiteFrames();
          caboSwapMultiIndices = [];
          caboDrawExchangeIndices = [];
          caboRender();
          socket.emit('caboDrawToDiscard');
        } else if (caboActionPhase === null && caboDiscardTop !== null) {
          clearWhiteFrames();
          caboSwapMultiIndices = [];
          caboDrawExchangeIndices = [];
          caboRender();
          socket.emit('caboTakeDiscard');
        }
      }
    };
  }
  const skipBtn = $('caboSkipSwap');
  if (skipBtn) {
    skipBtn.onclick = (e) => {
      e.stopPropagation();
      if (isMyTurn && caboActionPhase === 'swapMulti') {
        caboActionPhase = null;
        caboSwapMultiIndices = [];
        clearWhiteFrames();
        caboRender();
        socket.emit('caboSkipSwap');
      }
    };
  }
  const confirmBtn = $('caboDrawConfirm');
  if (confirmBtn) {
    confirmBtn.onclick = (e) => {
      e.stopPropagation();
      if (isMyTurn && caboDrawExchangeIndices.length >= 1) {
        if (caboActionPhase === 'drawn') {
          socket.emit('caboDrawExchange', { indices: [...caboDrawExchangeIndices] });
        } else if (caboActionPhase === 'takeDiscard') {
          socket.emit('caboDiscardExchange', { indices: [...caboDrawExchangeIndices] });
        }
        caboDrawExchangeIndices = [];
      }
    };
  }
  document.querySelectorAll('.cabo-row3-card').forEach(img => {
    img.onclick = () => {
      const idx = parseInt(img.dataset.index);
      if (!caboPeekDone && caboMyRow === 3) {
        if (!caboPeekedIndices.includes(idx) && caboPeekedIndices.length < 2) {
          caboPeekedIndices.push(idx);
          if (caboPeekedIndices.length === 2) {
            socket.emit('caboPeek', { indices: caboPeekedIndices });
          }
          caboRender();
        }
        return;
      }
      if (isMyTurn && caboMyRow === 3) {
        if (caboActionPhase === 'drawn') {
          const i = caboDrawExchangeIndices.indexOf(idx);
          if (i >= 0) {
            caboDrawExchangeIndices.splice(i, 1);
          } else {
            caboDrawExchangeIndices.push(idx);
          }
          caboRender();
        } else if (caboActionPhase === 'takeDiscard') {
          const i = caboDrawExchangeIndices.indexOf(idx);
          if (i >= 0) {
            caboDrawExchangeIndices.splice(i, 1);
          } else {
            caboDrawExchangeIndices.push(idx);
          }
          caboRender();
        } else if (caboActionPhase === 'peekOwn') {
          socket.emit('caboPeekOwnCard', { handIndex: idx });
        } else if (caboActionPhase === 'swapMulti') {
          if (caboSwapMultiIndices.includes(idx)) {
            caboSwapMultiIndices = [];
          } else {
            caboSwapMultiIndices = [idx];
          }
          caboRender();
        }
      }
      if (isMyTurn && caboMyRow === 4) {
        if (caboActionPhase === 'peekOther') {
          socket.emit('caboPeekOtherCard', { handIndex: idx });
        } else if (caboActionPhase === 'swapMulti') {
          if (caboSwapMultiIndices.length === 1) {
            socket.emit('caboSwapMulti', { myIndices: caboSwapMultiIndices, otherIndex: idx });
            caboSwapMultiIndices = [];
          }
        }
      }
    };
  });
  document.querySelectorAll('.cabo-row4-card').forEach(img => {
    img.onclick = () => {
      const idx = parseInt(img.dataset.index);
      if (!caboPeekDone && caboMyRow === 4) {
        if (!caboPeekedIndices.includes(idx) && caboPeekedIndices.length < 2) {
          caboPeekedIndices.push(idx);
          if (caboPeekedIndices.length === 2) {
            socket.emit('caboPeek', { indices: caboPeekedIndices });
          }
          caboRender();
        }
        return;
      }
      if (isMyTurn && caboMyRow === 4) {
        if (caboActionPhase === 'drawn') {
          const i = caboDrawExchangeIndices.indexOf(idx);
          if (i >= 0) {
            caboDrawExchangeIndices.splice(i, 1);
          } else {
            caboDrawExchangeIndices.push(idx);
          }
          caboRender();
        } else if (caboActionPhase === 'takeDiscard') {
          const i = caboDrawExchangeIndices.indexOf(idx);
          if (i >= 0) {
            caboDrawExchangeIndices.splice(i, 1);
          } else {
            caboDrawExchangeIndices.push(idx);
          }
          caboRender();
        } else if (caboActionPhase === 'peekOwn') {
          socket.emit('caboPeekOwnCard', { handIndex: idx });
        } else if (caboActionPhase === 'swapMulti') {
          if (caboSwapMultiIndices.includes(idx)) {
            caboSwapMultiIndices = [];
          } else {
            caboSwapMultiIndices = [idx];
          }
          caboRender();
        }
      }
      if (isMyTurn && caboMyRow === 3) {
        if (caboActionPhase === 'peekOther') {
          socket.emit('caboPeekOtherCard', { handIndex: idx });
        } else if (caboActionPhase === 'swapMulti') {
          if (caboSwapMultiIndices.length === 1) {
            socket.emit('caboSwapMulti', { myIndices: caboSwapMultiIndices, otherIndex: idx });
            caboSwapMultiIndices = [];
          }
        }
      }
    };
  });
}

socket.on('caboStart', ({ callerId, callerName, callerColor, opponentId, opponentName, opponentColor }) => {
});

socket.on('caboForceClose', () => {
  const panel = document.getElementById('caboPanel');
  if (panel) panel.remove();
});

socket.on('caboInit', ({ row3Name, row3Color, row3Cards, row4Name, row4Color, row4Cards, myRow, isCaller }) => {
  caboRow3Name = row3Name;
  caboRow3Color = row3Color;
  caboRow3Cards = [...row3Cards];
  caboRow4Name = row4Name;
  caboRow4Color = row4Color;
  caboRow4Cards = [...row4Cards];
  caboMyRow = myRow;
  caboIsCaller = isCaller;
  caboCurrentTurnId = null;
  caboPeekedIndices = [];
  caboDrawnCard = null;
  caboActionPhase = null;
  caboDiscardTop = null;
  caboMessageText = '请查看自己的2张牌';
  caboPeekDone = false;
  caboWhiteFrames = { row3: [], row4: [] };
  caboSwapMultiIndices = [];
  caboDrawExchangeIndices = [];
  caboFaceUpMap = { row3: [], row4: [] };
  caboPeekOtherValue = null;
  caboPeekOtherIndex = -1;
  caboSettled = false;
  caboCalled = false;
  caboRow3Sum = 0;
  caboRow4Sum = 0;
  caboCreatePanel();
  caboRender();
});

socket.on('caboPeekResult', ({ indices, values }) => {
  const myCards = caboGetMyCards();
  indices.forEach((idx, i) => {
    myCards[idx] = values[i];
  });
  caboPeekedIndices = [...indices];
  const myRowKey = caboMyRow === 3 ? 'row3' : 'row4';
  caboWhiteFrames[myRowKey] = [...indices];
  caboMessageText = '记住你的牌！3秒后翻回';
  caboRender();
  setTimeout(() => {
    if (caboSettled) return;
    caboPeekedIndices = [];
    caboPeekDone = true;
    if (caboCurrentTurnId === null) {
      caboMessageText = '等待对方查看...';
    }
    caboRender();
  }, 3000);
});

socket.on('caboTurnStart', ({ turnId, turnName, turnColor, discardTop }) => {
  caboCurrentTurnId = turnId;
  caboActionPhase = null;
  caboDrawnCard = null;
  caboDiscardTop = discardTop;
  caboSwapMultiIndices = [];
  caboDrawExchangeIndices = [];
  caboMessageText = `${turnName}的回合`;
  caboRender();
});

socket.on('caboUpdate', ({ message, turnId, turnName, turnColor, discardTop, caboCalled: called }) => {
  caboCurrentTurnId = turnId;
  caboDiscardTop = discardTop;
  caboActionPhase = null;
  caboPeekDone = true;
  caboCalled = !!called;
  caboMessageText = message;
  caboRender();
});

socket.on('caboDrawnCard', ({ card, discardTop }) => {
  caboDrawnCard = card;
  caboActionPhase = 'drawn';
  caboDiscardTop = discardTop;
  caboDrawExchangeIndices = [];
  if (card !== null) {
    caboMessageText = '请扔掉/与任意张自己点数相同的牌交换';
  } else {
    caboMessageText = '对方抽了一张牌';
  }
  caboRender();
});

socket.on('caboAction', ({ action, discardTop }) => {
  caboActionPhase = action;
  caboDiscardTop = discardTop;
  caboDrawnCard = null;
  if (action === 'peekOwn') caboMessageText = '请查看自己的1张牌';
  else if (action === 'peekOther') caboMessageText = '请偷看别人的1张牌';
  else if (action === 'swapMulti') { caboMessageText = '请选择自己的1张牌，再与对方交换1张'; caboSwapMultiIndices = []; }
  caboRender();
});

socket.on('caboTookDiscard', ({ card }) => {
  caboActionPhase = 'takeDiscard';
  caboDrawExchangeIndices = [];
  caboMessageText = '请扔掉/与任意张自己点数相同的牌交换';
  caboRender();
});

socket.on('caboPeekOtherResult', ({ index, value }) => {
  const otherRowKey = caboMyRow === 3 ? 'row4' : 'row3';
  caboWhiteFrames[otherRowKey] = [index];
  caboPeekOtherIndex = index;
  caboPeekOtherValue = value;
  caboMessageText = '偷看对方牌...';
  caboRender();
});

socket.on('caboWhiteFrame', ({ row, indices }) => {
  caboWhiteFrames[row] = indices;
  caboRender();
});

socket.on('caboClearShrink', () => {
  caboWhiteFrames = { row3: [], row4: [] };
  caboSwapMultiIndices = [];
  caboDrawExchangeIndices = [];
  caboPeekOtherIndex = -1;
  caboPeekOtherValue = null;
  caboRender();
});

socket.on('caboMultiSwapped', ({ row3Cards, row4Cards, shrinkIndices, faceUpMap }) => {
  caboRow3Cards = [...row3Cards];
  caboRow4Cards = [...row4Cards];
  caboWhiteFrames = { ...shrinkIndices };
  caboSwapMultiIndices = [];
  if (faceUpMap) {
    caboFaceUpMap = { row3: [...faceUpMap.row3], row4: [...faceUpMap.row4] };
  }
  caboRender();
});

socket.on('caboSwapMultiFailed', ({ row3Cards, row4Cards, shrinkIndices }) => {
  caboRow3Cards = [...row3Cards];
  caboRow4Cards = [...row4Cards];
  caboWhiteFrames = { ...shrinkIndices };
  caboSwapMultiIndices = [];
  caboMessageText = '点数不等，交换失败，额外获得1张牌';
  caboRender();
});

socket.on('caboDrawExchangeResult', ({ success, row3Cards, row4Cards, shrinkIndices, drawnCardValue, drawnCardPosition, discardTop, faceUpMap }) => {
  caboRow3Cards = [...row3Cards];
  caboRow4Cards = [...row4Cards];
  caboWhiteFrames = { ...shrinkIndices };
  caboDrawExchangeIndices = [];
  caboDrawnCard = null;
  caboActionPhase = null;
  if (discardTop !== undefined) caboDiscardTop = discardTop;
  if (faceUpMap) {
    caboFaceUpMap = { row3: [...faceUpMap.row3], row4: [...faceUpMap.row4] };
  }
  if (success) {
    caboMessageText = '交换成功！';
  } else {
    caboMessageText = '点数不同，交换失败';
  }
  caboRender();
});

socket.on('caboUpdateDiscardTop', ({ discardTop }) => {
  caboDiscardTop = discardTop;
  caboDrawnCard = null;
  caboRender();
});

socket.on('caboCardRevealed', ({ row, index, value }) => {
  if (row === 'row3') caboRow3Cards[index] = value;
  else caboRow4Cards[index] = value;
  if (!caboFaceUpMap[row].includes(index)) caboFaceUpMap[row].push(index);
  caboRender();
});

socket.on('caboSettle', ({ playerCards, opponentCards, playerSum, opponentSum, winnerId, winnerName, winnerColor, loserName, loserColor, isCaller, equalScore }) => {
  caboRow3Cards = caboMyRow === 4 ? [...opponentCards] : [...playerCards];
  caboRow4Cards = caboMyRow === 4 ? [...playerCards] : [...opponentCards];
  caboRow3Sum = caboMyRow === 4 ? opponentSum : playerSum;
  caboRow4Sum = caboMyRow === 4 ? playerSum : opponentSum;
  caboWhiteFrames = { row3: [], row4: [] };
  caboPeekedIndices = [];
  caboPeekDone = true;
  caboSettled = true;
  caboCurrentTurnId = null;
  caboActionPhase = null;
  caboDrawnCard = null;
  caboSwapMultiIndices = [];
  caboDrawExchangeIndices = [];
  caboMessageText = equalScore ? `点数相等，${winnerName}因为呼叫了卡波获得胜利` : `${winnerName}胜利`;
  caboRender();
  const panel = document.getElementById('caboPanel');
  if (!panel) return;
  const cur = players[currentPlayerIdx];
  const isCurrentPlayer = cur && cur.id === myId;
  if (isCurrentPlayer) {
    const closeDiv = document.createElement('div');
    closeDiv.style.cssText = 'position:absolute;top:4px;right:8px;width:28px;height:28px;background:#e74c3c;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:20px;font-weight:bold;line-height:1;z-index:10;';
    closeDiv.textContent = '×';
    closeDiv.id = 'caboCloseBtn';
    closeDiv.onclick = () => {
      panel.remove();
      socket.emit('caboClose');
      document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
      const endTurnBtn = document.getElementById('endTurnBtn');
      if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
    };
    panel.appendChild(closeDiv);
  }
});

// ===== 金花游戏 =====
let jinhuaMyCards = [];
let jinhuaMyCardSum = 0;
let jinhuaMyBetCount = 0;
let jinhuaMyGaveUp = false;
let jinhuaMySwapped = false;
let jinhuaPlayers = [];
let jinhuaCurrentBetPlayerId = null;
let jinhuaPhase = 'draw';
let jinhuaSettled = false;
let jinhuaBankCards = [];
let jinhuaBankSum = 0;
let jinhuaMaxBet = 0;
let jinhuaPanelVisible = false;

function jinhuaCreatePanel() {
  let existing = document.getElementById('jinhuaPanel');
  if (existing) existing.remove();
  const s1Area = document.getElementById('s1Area');
  if (!s1Area) return;
  const rect = s1Area.getBoundingClientRect();
  const panel = document.createElement('div');
  panel.id = 'jinhuaPanel';
  panel.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px;z-index:200;background:url(/drawable/bj5.jpg) center/cover no-repeat;display:flex;flex-direction:column;align-items:center;padding:clamp(4px,1vh,8px);box-sizing:border-box;overflow:hidden;`;
  document.body.appendChild(panel);
  return panel;
}

function jinhuaRender() {
  const panel = document.getElementById('jinhuaPanel');
  if (!panel) return;
  const fontSize = 'clamp(14px,3vw,20px)';
  const nameFontSize = 'clamp(14px,3vw,20px)';
  const cardH = 'clamp(70px,18vw,110px)';
  const textColor = '#fff';
  let html = '';

  // Top area: bank cards
  html += `<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;margin-bottom:6px;">`;
  if (jinhuaSettled && jinhuaBankCards.length === 2) {
    html += `<img src="/drawable/pukepai/${jinhuaBankCards[0]}.png" style="height:${cardH};object-fit:contain;">`;
    html += `<img src="/drawable/pukepai/${jinhuaBankCards[1]}.png" style="height:${cardH};object-fit:contain;">`;
  } else {
    html += `<img src="/drawable/pkb.jpg" style="height:${cardH};object-fit:contain;">`;
    html += `<img src="/drawable/pkb.jpg" style="height:${cardH};object-fit:contain;">`;
  }
  html += `<span style="color:${textColor};font-size:${fontSize};margin-left:4px;white-space:nowrap;">押注最多的与此比大小</span>`;
  html += `</div>`;

  // Middle area: player grids (2*3)
  const cols = Math.min(jinhuaPlayers.length, 3);
  const rows = Math.ceil(jinhuaPlayers.length / 3);
  html += `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;flex:1;overflow:hidden;width:100%;min-height:0;">`;
  for (let i = 0; i < jinhuaPlayers.length; i++) {
    const p = jinhuaPlayers[i];
    const isMe = p.id === myId;
    const betLabel = p.betCount > 0 ? `<span style="color:#e74c3c;font-size:${fontSize};">-${p.betCount}</span>` : '';
    const gaveUpLabel = p.gaveUp ? `<span style="color:#e74c3c;font-size:${fontSize};">放弃</span>` : '';

    html += `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px;">`;
    html += `<div style="display:flex;align-items:center;gap:2px;"><span style="color:${textColor};font-size:${nameFontSize};white-space:nowrap;">${p.name}</span>${betLabel}${gaveUpLabel}</div>`;

    if (jinhuaSettled && p.cards && p.cards.length === 2) {
      html += `<div style="display:flex;gap:2px;">`;
      html += `<img src="/drawable/pukepai/${p.cards[0]}.png" style="height:${cardH};object-fit:contain;">`;
      html += `<img src="/drawable/pukepai/${p.cards[1]}.png" style="height:${cardH};object-fit:contain;">`;
      html += `</div>`;
    } else if (isMe && jinhuaMyCards.length === 2) {
      html += `<div style="display:flex;gap:2px;">`;
      html += `<img src="/drawable/pukepai/${jinhuaMyCards[0]}.png?t=${Date.now()}" style="height:${cardH};object-fit:contain;">`;
      html += `<img src="/drawable/pukepai/${jinhuaMyCards[1]}.png?t=${Date.now()}" style="height:${cardH};object-fit:contain;">`;
      html += `</div>`;
    } else {
      html += `<div style="display:flex;gap:2px;">`;
      html += `<img src="/drawable/pkb.jpg" style="height:${cardH};object-fit:contain;">`;
      html += `<img src="/drawable/pkb.jpg" style="height:${cardH};object-fit:contain;">`;
      html += `</div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;

  // Bottom area: controls
  const isMyBetTurn = jinhuaCurrentBetPlayerId === myId && !jinhuaMyGaveUp && !jinhuaSettled;
  const canSwap = isMyBetTurn && !jinhuaMySwapped && jinhuaMyCards.length === 2;
  const showSwap = !jinhuaMySwapped && !jinhuaMyGaveUp && jinhuaMyCards.length === 2 && !jinhuaSettled && !jinhuaMyBetCount;
  const canBet1 = isMyBetTurn && jinhuaMyCardSum - (jinhuaMaxBet + 1) > 0;
  const canBet2 = isMyBetTurn && jinhuaMyCardSum - (jinhuaMaxBet + 2) > 0;
  const canGiveUp = isMyBetTurn;

  if (jinhuaMyGaveUp) {
    html += `<div style="flex-shrink:0;margin-top:4px;"></div>`;
  } else {
    html += `<div style="display:flex;align-items:center;gap:clamp(4px,1vw,8px);flex-shrink:0;margin-top:6px;width:100%;justify-content:center;white-space:nowrap;">`;
    const numValue = jinhuaMyCards.length === 2 ? (jinhuaMyCardSum - jinhuaMaxBet) : '';
    html += `<div id="jinhuaNumBox" style="width:clamp(36px,8vw,50px);height:clamp(28px,6vh,36px);background:#000;color:#fff;font-size:clamp(14px,3vw,20px);text-align:center;line-height:clamp(28px,6vh,36px);border-radius:4px;flex-shrink:0;">${numValue}</div>`;
    html += `<button id="jinhuaBet1Btn" class="jinhua-ctrl-btn" style="background:${canBet1 ? '#fff' : '#ccc'};cursor:${canBet1 ? 'pointer' : 'default'};" ${canBet1 ? '' : 'disabled'}>押注-1</button>`;
    html += `<button id="jinhuaBet2Btn" class="jinhua-ctrl-btn" style="background:${canBet2 ? '#fff' : '#ccc'};cursor:${canBet2 ? 'pointer' : 'default'};" ${canBet2 ? '' : 'disabled'}>押注-2</button>`;
    html += `<button id="jinhuaGiveUpBtn" class="jinhua-ctrl-btn" style="background:${canGiveUp ? '#fff' : '#ccc'};cursor:${canGiveUp ? 'pointer' : 'default'};" ${canGiveUp ? '' : 'disabled'}>放弃</button>`;
    if (showSwap) {
      html += `<button id="jinhuaSwapBtn" class="jinhua-ctrl-btn" style="background:${canSwap ? '#fff' : '#ccc'};cursor:${canSwap ? 'pointer' : 'default'};" ${canSwap ? '' : 'disabled'}>换牌</button>`;
    }
    html += `</div>`;
  }

  panel.innerHTML = html;
  let styleEl = document.getElementById('jinhuaPanelStyle');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'jinhuaPanelStyle';
    styleEl.textContent = `.jinhua-ctrl-btn { padding:clamp(4px,1vw,14px) clamp(8px,2vw,14px);color:#000;border:none;border-radius:4px;font-size:clamp(12px,2.5vw,20px);white-space:nowrap;flex-shrink:0; } .jinhua-ctrl-btn:hover:not(:disabled) { background:#ddd !important; } .jinhua-ctrl-btn:disabled { background:#ccc !important; color:#999 !important; cursor:default !important; }`;
    panel.appendChild(styleEl);
  }
  jinhuaBindEvents();
}

function jinhuaBindEvents() {
  const bet1Btn = document.getElementById('jinhuaBet1Btn');
  if (bet1Btn && !bet1Btn.disabled) {
    bet1Btn.onclick = () => socket.emit('jinhuaBet', { amount: 1 });
  }

  const bet2Btn = document.getElementById('jinhuaBet2Btn');
  if (bet2Btn && !bet2Btn.disabled) {
    bet2Btn.onclick = () => socket.emit('jinhuaBet', { amount: 2 });
  }

  const giveUpBtn = document.getElementById('jinhuaGiveUpBtn');
  if (giveUpBtn && !giveUpBtn.disabled) {
    giveUpBtn.onclick = () => socket.emit('jinhuaGiveUp');
  }

  const swapBtn = document.getElementById('jinhuaSwapBtn');
  if (swapBtn && !swapBtn.disabled) {
    swapBtn.onclick = () => {
      socket.emit('jinhuaSwapCards');
    };
  }
}

socket.on('jinhuaStart', ({ currentPlayerId, players: jPlayers }) => {
  jinhuaMyCards = [];
  jinhuaMyCardSum = 0;
  jinhuaMyBetCount = 0;
  jinhuaMyGaveUp = false;
  jinhuaMySwapped = false;
  jinhuaPlayers = jPlayers.map(p => ({ ...p, cards: [], cardSum: 0, betCount: 0, gaveUp: false }));
  jinhuaCurrentBetPlayerId = null;
  jinhuaPhase = 'draw';
  jinhuaSettled = false;
  jinhuaBankCards = [];
  jinhuaBankSum = 0;
  jinhuaMaxBet = 0;
  jinhuaPanelVisible = false;
  // Don't show panel yet - wait for click on 金花 button
  // F area: only current player shows 金花 and 结束
  const areaF = document.getElementById('areaF');
  if (areaF && currentPlayerId === myId) {
    areaF.innerHTML = '';
    const jinhuaBtn = document.createElement('button');
    jinhuaBtn.className = 'jail-btn';
    jinhuaBtn.textContent = '金花';
    jinhuaBtn.onclick = () => {
      areaF.innerHTML = '';
      socket.emit('jinhuaOpenPanel');
    };
    areaF.appendChild(jinhuaBtn);
    const endBtn = document.createElement('button');
    endBtn.className = 'jail-btn';
    endBtn.textContent = '结束';
    endBtn.onclick = () => doEndTurn();
    areaF.appendChild(endBtn);
  }
});

socket.on('jinhuaShowPanel', () => {
  jinhuaPanelVisible = true;
  jinhuaCreatePanel();
  jinhuaRender();
});

socket.on('jinhuaCardsDrawn', ({ cards, cardSum }) => {
  jinhuaMyCards = cards;
  jinhuaMyCardSum = cardSum;
  jinhuaMyBetCount = 0;
  const me = jinhuaPlayers.find(p => p.id === myId);
  if (me) { me.cards = cards; me.cardSum = cardSum; }
  if (jinhuaPanelVisible) jinhuaRender();
});

socket.on('jinhuaPlayerDrawn', ({ playerId }) => {
  const p = jinhuaPlayers.find(pp => pp.id === playerId);
  if (p && p.id !== myId) { p.cards = [-1, -1]; }
  if (jinhuaPanelVisible) jinhuaRender();
});

socket.on('jinhuaAllDrawn', ({ firstBetPlayerId }) => {
  jinhuaPhase = 'swap';
  jinhuaCurrentBetPlayerId = firstBetPlayerId;
  const firstP = jinhuaPlayers.find(p => p.id === firstBetPlayerId);
  if (firstP) {
    $('areaE').innerHTML = `<span style="color:#fff;">${firstP.name}请押注</span>`;
    fitAreaEText();
  }
  if (jinhuaPanelVisible) jinhuaRender();
});

socket.on('jinhuaCardsSwapped', ({ cards, cardSum }) => {
  jinhuaMyCards = cards;
  jinhuaMyCardSum = cardSum;
  const me = jinhuaPlayers.find(p => p.id === myId);
  if (me) { me.cards = cards; me.cardSum = cardSum; }
  jinhuaMySwapped = true;
  if (jinhuaPanelVisible) jinhuaRender();
});

socket.on('jinhuaPlayerSwapped', ({ playerId }) => {
  // Other player swapped - no visible change for us
  if (jinhuaPanelVisible) jinhuaRender();
});

socket.on('jinhuaPlayerBet', ({ playerId, betCount, newSum, maxBet }) => {
  const p = jinhuaPlayers.find(pp => pp.id === playerId);
  if (p) {
    p.betCount = betCount;
    if (p.id === myId) {
      jinhuaMyBetCount = betCount;
    }
  }
  if (maxBet !== undefined) jinhuaMaxBet = maxBet;
  if (jinhuaPhase === 'swap') jinhuaPhase = 'bet';
  if (jinhuaPanelVisible) jinhuaRender();
});

socket.on('jinhuaPlayerGaveUp', ({ playerId }) => {
  const p = jinhuaPlayers.find(pp => pp.id === playerId);
  if (p) {
    p.gaveUp = true;
    if (p.id === myId) {
      jinhuaMyGaveUp = true;
    }
  }
  if (jinhuaPhase === 'swap') jinhuaPhase = 'bet';
  if (jinhuaPanelVisible) jinhuaRender();
});

socket.on('jinhuaNextTurn', ({ currentPlayerId, maxBet }) => {
  jinhuaCurrentBetPlayerId = currentPlayerId;
  if (maxBet !== undefined) jinhuaMaxBet = maxBet;
  const p = jinhuaPlayers.find(pp => pp.id === currentPlayerId);
  if (p) {
    const betP = jinhuaPlayers.filter(pp => !pp.gaveUp && pp.betCount > 0).sort((a, b) => b.betCount - a.betCount)[0];
    const betPText = betP ? `${betP.name}最大押注${betP.betCount}，` : '';
    $('areaE').innerHTML = `<span style="color:#fff;">${betPText}${p.name}请押注</span>`;
    fitAreaEText();
  }
  if (jinhuaPanelVisible) jinhuaRender();
});

socket.on('jinhuaSettle', ({ bankCards, bankSum, winnerId, winnerSum, won, eMsg, allPlayerCards }) => {
  jinhuaSettled = true;
  jinhuaBankCards = bankCards;
  jinhuaBankSum = bankSum;
  jinhuaPhase = 'settle';
  // Update all player cards for display
  allPlayerCards.forEach(pc => {
    const p = jinhuaPlayers.find(pp => pp.id === pc.playerId);
    if (p) {
      p.cards = pc.cards;
      p.gaveUp = pc.gaveUp;
      p.betCount = pc.betCount;
    }
  });
  $('areaE').innerHTML = eMsg;
  fitAreaEText();
  // Ensure panel is visible for settlement
  if (!jinhuaPanelVisible) {
    jinhuaPanelVisible = true;
    jinhuaCreatePanel();
  }
  jinhuaRender();
  // Add close button for current player
  const panel = document.getElementById('jinhuaPanel');
  if (!panel) return;
  const cur = players[currentPlayerIdx];
  if (cur && cur.id === myId) {
    const closeDiv = document.createElement('div');
    closeDiv.style.cssText = 'position:absolute;top:4px;right:8px;width:28px;height:28px;background:#e74c3c;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:20px;font-weight:bold;line-height:1;z-index:10;';
    closeDiv.textContent = '×';
    closeDiv.onclick = () => {
      panel.remove();
      socket.emit('jinhuaClose');
      document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
      const endTurnBtn = document.getElementById('endTurnBtn');
      if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
    };
    panel.appendChild(closeDiv);
  }
});

socket.on('jinhuaForceClose', () => {
  const panel = document.getElementById('jinhuaPanel');
  if (panel) panel.remove();
});

socket.on('jiandieStart', ({ playerId, playerName, playerColor }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button class="jail-btn" id="jiandieBtn">间谍</button><button class="jail-btn" onclick="doEndTurn();">结束</button>`;
  document.getElementById('jiandieBtn').onclick = () => {
    areaF.innerHTML = '';
    const validTargets = players.filter(p => !p.bankrupt && !p.sheltered && p.id !== myId);
    if (validTargets.length < 2) {
      $('areaE').innerHTML = '没有足够的目标';
      fitAreaEText();
      areaF.innerHTML = '<button class="jail-btn" onclick="doEndTurn();">结束</button>';
      return;
    }
    selectingJiandieTarget = true;
    jiandieSelectedFirst = null;
    refreshPlayerCards();
    checkNoValidTarget();
  };
});

window.selectJiandieTarget = function(targetId) {
  if (!selectingJiandieTarget) return;
  if (targetId === myId) return;
  if (!jiandieSelectedFirst) {
    jiandieSelectedFirst = targetId;
    refreshPlayerCards();
  } else {
    if (targetId === jiandieSelectedFirst) return;
    selectingJiandieTarget = false;
    const targetAId = jiandieSelectedFirst;
    const targetBId = targetId;
    jiandieSelectedFirst = null;
    refreshPlayerCards();
    socket.emit('jiandieSelectTargets', { targetAId, targetBId });
  }
};

socket.on('lunciStartSelect', ({ playerId, playerName, playerColor }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button class="jail-btn" onclick="socket.emit('lunciConfirm');">轮次</button><button class="jail-btn" onclick="doEndTurn();">结束</button>`;
});

socket.on('lunciSelectTarget', ({ currentPlayerId, currentPlayerName, currentPlayerColor }) => {
  if (myId !== currentPlayerId) return;
  selectingLunciTarget = true;
  $('areaE').innerHTML = '请选择轮次目标玩家';
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button class="jail-btn" onclick="doEndTurn();">结束</button>`;
  refreshPlayerCards();
});

window.selectLunciTarget = function(targetId) {
  if (!selectingLunciTarget) return;
  selectingLunciTarget = false;
  socket.emit('lunciSelectTargetConfirm', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
};

socket.on('lunciStart', (data) => {
  showLunciPanel(data);
});

socket.on('lunciNextRound', (data) => {
  updateLunciPanel(data);
});

socket.on('lunciCardSelected', ({ playerId, cardIndex }) => {
  updateLunciCardSelection(playerId, cardIndex);
});

socket.on('lunciResult', (data) => {
  showLunciResult(data);
});

socket.on('lunciClosed', () => {
  const panel = document.getElementById('lunciPanel');
  if (panel) panel.remove();
  const areaF = document.getElementById('areaF');
  if (myId === players[currentPlayerIdx]?.id) {
    areaF.innerHTML = `<button class="jail-btn" onclick="doEndTurn();">结束</button>`;
  }
});

socket.on('qiyuXinlixueStart', ({ currentPlayerId, currentPlayerName, currentPlayerColor }) => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button class="jail-btn" onclick="socket.emit('qiyuXinlixueChoice', { choice: '3' });">3</button><button class="jail-btn" onclick="socket.emit('qiyuXinlixueChoice', { choice: '6' });">6</button><button class="jail-btn" onclick="socket.emit('qiyuXinlixueChoice', { choice: '9' });">9</button>`;
});

socket.on('qiyuXinlixueChoiceMade', () => {
  document.getElementById('areaF').innerHTML = '';
});

socket.on('qiyuLianhuanjiStart', ({ currentPlayerId, currentPlayerName, currentPlayerColor, nextPlayerId, nextPlayerName, nextPlayerColor }) => {
  if (myId === currentPlayerId || myId === nextPlayerId) {
    showDiceSelectInF(3, 6, (i) => {
      socket.emit('qiyuLianhuanjiChoice', { choice: String(i) });
    });
  }
});

socket.on('qiyuLianhuanjiContinue', ({ currentPlayerId, currentPlayerName, currentPlayerColor, nextPlayerId, nextPlayerName, nextPlayerColor }) => {
  if (myId === currentPlayerId || myId === nextPlayerId) {
    showDiceSelectInF(3, 6, (i) => {
      socket.emit('qiyuLianhuanjiChoice', { choice: String(i) });
    });
  }
});

socket.on('qiyuLianhuanjiChoiceMade', () => {
  document.getElementById('areaF').innerHTML = '';
});

socket.on('qiyuShoumaiStart', ({ playerId, playerName, playerColor }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="qiyuShoumaiBtn" class="jail-btn">收买</button><button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('qiyuShoumaiBtn').onclick = () => {
    areaF.innerHTML = '';
    showShoumaiDicePanel();
  };
  document.getElementById('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

function showShoumaiDicePanel() {
  showDiceSelectInF(1, 6, (i) => {
    socket.emit('qiyuShoumaiConfirm', { diceValue: i });
  });
}

// 瞒天过海：当前玩家选择点数
socket.on('mantianGuohaiCurrentPlayerSelect', ({ currentPlayerId, currentPlayerName, currentPlayerColor }) => {
  if (myId !== currentPlayerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
  showDiceSelectInF(1, 6, (i) => {
    socket.emit('mantianGuohaiChoose', { diceValue: i });
  });
});

// 瞒天过海：其他玩家猜测点数
socket.on('mantianGuohaiOthersSelect', ({ currentPlayerId, currentPlayerName, currentPlayerColor }) => {
  if (myId === currentPlayerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
  showDiceSelectInF(1, 6, (i) => {
    socket.emit('mantianGuohaiChoose', { diceValue: i });
  });
});

// 清空F区
socket.on('clearAreaF', () => {
  const areaF = document.getElementById('areaF');
  if (areaF) areaF.innerHTML = '';
});

// 瞒天过海：当前玩家M3显示touzi.png
socket.on('mantianGuohaiShowDice', ({ diceValue }) => {
  const m3 = $('m3');
  if (m3) {
    m3.innerHTML = `<img src="/drawable/touzi.png" style="width:100%;height:100%;cursor:pointer;" title="下回合掷${diceValue}">`;
  }
});

// 合作任务：当前玩家选择目标
socket.on('hezuorenwuStart', ({ playerId, targets }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="hezuorenwuBtn" class="jail-btn">合作</button><button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('hezuorenwuBtn').onclick = () => {
    if (targets.length === 0) {
      $('areaE').innerHTML = '没有合适的目标';
      areaF.innerHTML = `<button id="endTurnBtn" class="jail-btn">结束</button>`;
      document.getElementById('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
      return;
    }
    areaF.innerHTML = '';
    window.hezuorenwuSelectingTarget = true;
    window.hezuorenwuTargets = targets;
    render();
    refreshPlayerCards();
    checkNoValidTarget();
  };
  document.getElementById('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

// 合作任务：显示面板
socket.on('hezuorenwuShowPanel', ({ isCurrentPlayer, targetName, targetColor, currentName, currentColor }) => {
  const hArea = document.getElementById('hArea');
  if (!hArea) return;
  
  const me = players.find(p => p.id === myId);
  const maxMoney = me ? (me.money + (me.tempMoney || 0)) : 0;
  
  let existing = document.getElementById('hezuorenwuPanel');
  if (existing) existing.remove();
  
  const panel = document.createElement('div');
  panel.id = 'hezuorenwuPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:clamp(8px,2vh,20px);overflow:hidden;';
  
  const otherName = isCurrentPlayer ? targetName : currentName;
  const otherColor = isCurrentPlayer ? targetColor : currentColor;
  
  panel.innerHTML = `
    <img src="/drawable/jiyu/hezuorenwu.jpg" style="max-width:70%;max-height:18vh;width:auto;height:auto;margin-bottom:clamp(6px,1.5vh,20px);object-fit:contain;">
    <div style="color:#fff;font-size:clamp(12px,2.5vh,20px);margin-bottom:clamp(6px,1.5vh,10px);text-align:center;">与${coloredName(otherName, otherColor)}合作凑钱</div>
    <div style="display:flex;align-items:center;gap:clamp(4px,1vw,10px);margin-bottom:clamp(6px,1.5vh,20px);flex-wrap:wrap;justify-content:center;">
      <input type="text" id="hezuorenwuInput" value="0" readonly style="width:clamp(80px,20vw,120px);text-align:center;font-size:clamp(18px,4vh,28px);background:#fff;color:#000;border:1px solid #666;padding:clamp(4px,1vh,10px);border-radius:4px;font-weight:bold;">
      <button id="hezuorenwuConfirmBtn" class="calc-btn" disabled style="color:transparent;">确定</button>
    </div>
    <div style="display:flex;gap:clamp(4px,1vw,8px);margin-bottom:clamp(4px,1vh,8px);flex-wrap:wrap;justify-content:center;">
      <button class="calc-btn calc-num" data-num="0">0</button>
      <button class="calc-btn calc-num" data-num="1">1</button>
      <button class="calc-btn calc-num" data-num="2">2</button>
      <button class="calc-btn calc-num" data-num="3">3</button>
      <button class="calc-btn calc-num" data-num="4">4</button>
    </div>
    <div style="display:flex;gap:clamp(4px,1vw,8px);flex-wrap:wrap;justify-content:center;">
      <button class="calc-btn calc-num" data-num="5">5</button>
      <button class="calc-btn calc-num" data-num="6">6</button>
      <button class="calc-btn calc-num" data-num="7">7</button>
      <button class="calc-btn calc-num" data-num="8">8</button>
      <button class="calc-btn calc-num" data-num="9">9</button>
    </div>
  `;
  
  const style = document.createElement('style');
  style.textContent = `.calc-btn { min-width:clamp(36px,9vw,50px);height:clamp(36px,9vw,50px);background:#333;color:#fff;border:none;border-radius:clamp(4px,1vh,8px);font-size:clamp(14px,3.5vw,20px);cursor:pointer;padding:0 clamp(4px,1vw,12px);white-space:nowrap; } .calc-btn:hover { background:#555; } .calc-btn:disabled { background:#333 !important; color:transparent !important; opacity:1 !important; }`;
  panel.appendChild(style);
  
  hArea.style.position = 'relative';
  hArea.appendChild(panel);
  
  let currentValue = '0';
  const input = document.getElementById('hezuorenwuInput');
  const confirmBtn = document.getElementById('hezuorenwuConfirmBtn');
  
  const updateBtn = () => {
    if (currentValue === '0') {
      confirmBtn.disabled = true;
      confirmBtn.style.color = 'transparent';
    } else {
      confirmBtn.disabled = false;
      confirmBtn.style.color = '#fff';
    }
  };
  
  panel.querySelectorAll('.calc-num').forEach(btn => {
    btn.onclick = () => {
      const num = btn.dataset.num;
      let newValue;
      if (currentValue === '0') {
        newValue = num;
      } else {
        newValue = currentValue + num;
      }
      if (parseInt(newValue) > 999) {
        return;
      }
      currentValue = newValue;
      input.value = currentValue;
      updateBtn();
    };
  });
  
  confirmBtn.onclick = () => {
    const money = parseInt(currentValue) || 0;
    panel.remove();
    socket.emit('hezuorenwuInputMoney', { money });
  };
});

// 合作任务：等待对方凑钱
socket.on('hezuorenwuWaiting', () => {
  const hArea = document.getElementById('hArea');
  if (!hArea) return;
  
  let existing = document.getElementById('hezuorenwuPanel');
  if (existing) existing.remove();
  
  const panel = document.createElement('div');
  panel.id = 'hezuorenwuPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;background:#000;display:flex;align-items:center;justify-content:center;';
  panel.innerHTML = '<div style="color:#fff;font-size:24px;">等待对方凑钱...</div>';
  
  hArea.style.position = 'relative';
  hArea.appendChild(panel);
});

// 合作任务：关闭面板
socket.on('hezuorenwuClose', () => {
  const panel = document.getElementById('hezuorenwuPanel');
  if (panel) panel.remove();
});

// 迷惑：开始
socket.on('meihuoStart', ({ playerId, targets }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="meihuoBtn" class="jail-btn">迷惑</button><button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('meihuoBtn').onclick = () => {
    if (targets.length === 0) {
      $('areaE').innerHTML = '没有合适的目标';
      areaF.innerHTML = `<button id="endTurnBtn" class="jail-btn">结束</button>`;
      document.getElementById('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
      return;
    }
    areaF.innerHTML = '';
    window.meihuoSelectingTarget = true;
    window.meihuoTargets = targets;
    render();
    refreshPlayerCards();
    checkNoValidTarget();
  };
  document.getElementById('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

// 迷惑：选择点数
socket.on('meihuoSelectDice', () => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
  showDiceSelectInF(1, 6, (i) => {
    socket.emit('meihuoChooseDice', { diceValue: i });
  });
});

// 迷惑：显示点数选项
socket.on('meihuoShowDiceOptions', ({ currentPlayerId, currentPlayerName, currentPlayerColor, targetId, targetName, targetColor, diceOptions }) => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
  
  const isTarget = myId === targetId;
  let html = '<div style="display:flex;gap:8px;justify-content:center;">';
  diceOptions.forEach(d => {
    if (isTarget) {
      html += `<img src="/drawable/touzi/T${d}.png" style="width:50px;height:50px;cursor:pointer;border-radius:4px;" class="meihuo-dice-img" data-dice="${d}">`;
    } else {
      html += `<img src="/drawable/touzi/T${d}.png" style="width:50px;height:50px;border-radius:4px;opacity:0.5;">`;
    }
  });
  html += '</div>';
  areaF.innerHTML = html;
  
  if (isTarget) {
    areaF.querySelectorAll('.meihuo-dice-img').forEach(img => {
      img.onclick = () => {
        const diceValue = parseInt(img.dataset.dice);
        socket.emit('meihuoGuessDice', { diceValue });
        areaF.innerHTML = '';
      };
    });
  }
});

// 迷惑：选择剩余点数
socket.on('meihuoSelectRemaining', ({ remainingDice }) => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
  let html = '<div style="display:flex;gap:8px;justify-content:center;">';
  remainingDice.forEach(d => {
    html += `<img src="/drawable/touzi/T${d}.png" style="width:50px;height:50px;cursor:pointer;border-radius:4px;" class="meihuo-remaining-img" data-dice="${d}">`;
  });
  html += '</div>';
  areaF.innerHTML = html;
  
  areaF.querySelectorAll('.meihuo-remaining-img').forEach(img => {
    img.onclick = () => {
      const diceValue = parseInt(img.dataset.dice);
      socket.emit('meihuoChooseRemaining', { diceValue });
      areaF.innerHTML = '';
    };
  });
});

// 迷惑：显示骰子图标
socket.on('meihuoShowDiceIcon', ({ diceValue }) => {
  const m3 = $('m3');
  if (m3) {
    m3.innerHTML = `<img src="/drawable/touzi.png" style="width:100%;height:100%;cursor:pointer;" title="下回合掷${diceValue}">`;
  }
});

// 打猎：开始
socket.on('dalieStart', ({ currentPlayerId, currentPlayerName, currentPlayerColor }) => {
  if (myId !== currentPlayerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="dalieBtn" class="jail-btn">打猎</button><button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('dalieBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('dalieBegin');
  };
  document.getElementById('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

// 打猎：显示面板
socket.on('dalieGameStart', ({ currentPlayerId, currentPlayerName, currentPlayerColor }) => {
  const isCurrentPlayer = myId === currentPlayerId;
  
  // 创建全屏面板
  const panel = document.createElement('div');
  panel.id = 'daliePanel';
  panel.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300;background:url(/drawable/jiyu/dalie/dalie.jpg) center/cover no-repeat;display:flex;flex-direction:column;';
  
  // 时间线
  const timeline = document.createElement('div');
  timeline.id = 'dalieTimeline';
  timeline.style.cssText = 'width:100%;height:20px;background:#f00;';
  panel.appendChild(timeline);
  
  // 格子区域（全屏，在时间线下方）
  const gridContainer = document.createElement('div');
  gridContainer.id = 'dalieGrid';
  gridContainer.style.cssText = 'display:grid;grid-template-columns:repeat(5,1fr);grid-template-rows:repeat(8,1fr);gap:5px;width:100%;flex:1;padding:10px;';
  
  for (let i = 0; i < 40; i++) {
    const cell = document.createElement('div');
    cell.className = 'dalie-cell';
    cell.dataset.index = i;
    cell.style.cssText = 'background:transparent;border-radius:4px;display:flex;align-items:center;justify-content:center;';
    gridContainer.appendChild(cell);
  }
  
  panel.appendChild(gridContainer);
  
  // 开始按钮和提示（覆盖在格子上方，居中显示）
  const startContainer = document.createElement('div');
  startContainer.id = 'dalieStartContainer';
  startContainer.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;z-index:10;';
  
  // 提示文字（在开始按钮上方，不换行）
  const hint = document.createElement('div');
  hint.id = 'dalieHint';
  hint.textContent = `${currentPlayerName}正在打猎，不要打到人`;
  hint.style.cssText = 'color:#000;font-size:24px;margin-bottom:10px;white-space:nowrap;';
  startContainer.appendChild(hint);
  
  const startBtn = document.createElement('button');
  startBtn.id = 'dalieStartBtn';
  startBtn.textContent = '开始';
  startBtn.style.cssText = 'padding:15px 40px;font-size:24px;background:#333;color:#fff;border:none;border-radius:8px;cursor:pointer;';
  if (isCurrentPlayer) {
    startBtn.onclick = () => {
      startContainer.remove();
      window.dalieGameStarted = true;
      socket.emit('dalieStartGame');
    };
  } else {
    startBtn.disabled = true;
    startBtn.style.opacity = '0.5';
    startBtn.style.cursor = 'default';
  }
  startContainer.appendChild(startBtn);
  
  panel.appendChild(startContainer);
  
  // 关闭按钮（右上角红×，仅当前玩家显示）
  if (isCurrentPlayer) {
    const closeBtn = document.createElement('div');
    closeBtn.id = 'dalieCloseBtn';
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'position:absolute;top:20px;right:20px;width:40px;height:40px;background:#f00;color:#fff;font-size:24px;border-radius:50%;display:none;align-items:center;justify-content:center;cursor:pointer;';
    closeBtn.onclick = () => {
      socket.emit('dalieClose');
    };
    panel.appendChild(closeBtn);
  }
  
  document.body.appendChild(panel);
  
  window.dalieTimer = null;
  window.dalieRefreshTimer = null;
  window.dalieTimeLeft = 20;
  window.dalieScore = 0;
  window.dalieGameOver = false;
  window.dalieGameStarted = false;
  window.dalieIsCurrentPlayer = isCurrentPlayer;
});

// 打猎：服务器通知游戏已开始（所有玩家）
socket.on('dalieGameStarted', () => {
  window.dalieGameStarted = true;
  const startContainer = document.getElementById('dalieStartContainer');
  if (startContainer) startContainer.remove();
});

// 打猎：服务器刷新格子
socket.on('dalieGridRefresh', ({ gridData }) => {
  if (!window.dalieGameStarted) return;
  
  const grid = document.getElementById('dalieGrid');
  if (!grid || window.dalieGameOver) return;
  
  // 清空所有格子
  grid.querySelectorAll('.dalie-cell').forEach(cell => {
    cell.innerHTML = '';
    cell.dataset.type = '';
    cell.style.cursor = 'default';
    cell.onclick = null;
  });
  
  // 根据服务器数据刷新
  gridData.forEach((type, index) => {
    const cell = grid.querySelector(`.dalie-cell[data-index="${index}"]`);
    if (!cell) return;
    
    if (type) {
      cell.dataset.type = type;
      const imgSrc = `/drawable/jiyu/dalie/${type}.png`;
      cell.innerHTML = `<img src="${imgSrc}" style="width:80%;height:80%;object-fit:contain;">`;
      
      if (window.dalieIsCurrentPlayer && !window.dalieGameOver) {
        cell.style.cursor = 'pointer';
        const handleTap = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const cellType = cell.dataset.type;
          const cellIndex = parseInt(cell.dataset.index);
          if (!cellType || window.dalieGameOver) return;
          socket.emit('dalieClickCell', { cellIndex, cellType });
        };
        cell.addEventListener('touchstart', handleTap, { passive: false });
        cell.onclick = handleTap;
      }
    }
  });
});

// 打猎：服务器时间更新
socket.on('dalieTimeUpdate', ({ timeLeft }) => {
  // 如果还没点击开始按钮，忽略时间更新
  if (!window.dalieGameStarted) return;
  
  const timeline = document.getElementById('dalieTimeline');
  if (timeline) {
    timeline.style.width = `${(timeLeft / 18) * 100}%`;
  }
});

// 打猎：格子点击结果
socket.on('dalieCellResult', ({ cellIndex, result, score }) => {
  window.dalieScore = score;
  
  const cell = document.querySelector(`.dalie-cell[data-index="${cellIndex}"]`);
  if (!cell) return;
  
  if (result === 'fenmu') {
    cell.innerHTML = `<img src="/drawable/jiyu/dalie/fenmu.png" style="width:80%;height:80%;object-fit:contain;">`;
    cell.onclick = null;
    cell.style.cursor = 'default';
  } else if (result === 'human') {
    cell.innerHTML = `<div style="color:#f00;font-size:48px;font-weight:bold;">×</div>`;
    window.dalieGameOver = true;
    
    document.querySelectorAll('.dalie-cell').forEach(c => {
      c.onclick = null;
      c.style.cursor = 'default';
    });
    
    if (window.dalieIsCurrentPlayer) {
      const closeBtn = document.getElementById('dalieCloseBtn');
      if (closeBtn) {
        closeBtn.style.display = 'flex';
        closeBtn.onclick = () => {
          socket.emit('dalieHitHumanEnd');
        };
      }
    }
  }
});

// 打猎：游戏结束
socket.on('dalieGameOver', ({ hitHuman, score }) => {
  window.dalieGameOver = true;
  
  document.querySelectorAll('.dalie-cell').forEach(c => {
    c.onclick = null;
    c.style.cursor = 'default';
  });
  
  // 显示关闭按钮（仅当前玩家）
  if (window.dalieIsCurrentPlayer) {
    const closeBtn = document.getElementById('dalieCloseBtn');
    if (closeBtn) {
      closeBtn.style.display = 'flex';
      if (hitHuman) {
        closeBtn.onclick = () => {
          socket.emit('dalieHitHumanEnd');
        };
      } else {
        closeBtn.onclick = () => {
          socket.emit('dalieClose');
        };
      }
    }
  }
});

// 打猎：关闭面板
socket.on('daliePanelClose', () => {
  const panel = document.getElementById('daliePanel');
  if (panel) panel.remove();
});

// 精算：开始
socket.on('jingsuanStart', ({ currentPlayerId, currentPlayerName, currentPlayerColor, cards }) => {
  if (myId !== currentPlayerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="jingsuanBtn" class="jail-btn">精算</button><button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('jingsuanBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('jingsuanBegin');
  };
  document.getElementById('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

// 精算：显示面板
socket.on('jingsuanGameStart', ({ currentPlayerId, currentPlayerName, currentPlayerColor, cards, upperCards, lowerCards, leftZone: serverLeftZone, rightZone: serverRightZone }) => {
  const isCurrentPlayer = myId === currentPlayerId;
  
  // 获取S1区域的位置，面板只覆盖S1
  const s1Area = document.getElementById('s1Area');
  if (!s1Area) return;
  const s1Rect = s1Area.getBoundingClientRect();
  
  // 创建面板（只覆盖S1区）
  const panel = document.createElement('div');
  panel.id = 'jingsuanPanel';
  panel.style.cssText = `position:fixed;top:${s1Rect.top}px;left:${s1Rect.left}px;width:${s1Rect.width}px;height:${s1Rect.height}px;z-index:300;background:url(/drawable/jiyu/jinsuanshi.jpg) center/cover no-repeat;display:flex;flex-direction:column;padding:clamp(2px,0.5vh,6px);overflow:hidden;`;
  
  // 时间线（红色）
  const timeline = document.createElement('div');
  timeline.id = 'jingsuanTimeline';
  timeline.style.cssText = 'width:100%;height:clamp(4px,1vh,10px);background:#f00;border-radius:4px;flex-shrink:0;';
  panel.appendChild(timeline);
  
  // A区（上半区域，9张牌上5下4排列 + 右侧开始按钮）
  const upperArea = document.createElement('div');
  upperArea.id = 'jingsuanUpperArea';
  upperArea.style.cssText = 'display:flex;gap:clamp(2px,0.5vw,6px);padding:clamp(2px,0.5vh,6px);border-radius:6px;margin-top:clamp(2px,0.5vh,6px);background:rgba(0,0,0,0.5);flex:1;min-height:0;align-items:center;overflow:hidden;';
  
  // A区左侧：牌区域（两排）
  const upperCardsWrap = document.createElement('div');
  upperCardsWrap.style.cssText = 'display:flex;flex-direction:column;gap:clamp(3px,0.8vh,8px);';
  
  // A区上排（5张）
  const upperRow1 = document.createElement('div');
  upperRow1.id = 'jingsuanUpperRow1';
  upperRow1.style.cssText = 'display:flex;gap:clamp(3px,0.8vw,8px);justify-content:center;align-items:center;';
  upperCardsWrap.appendChild(upperRow1);
  
  // A区下排（4张）
  const upperRow2 = document.createElement('div');
  upperRow2.id = 'jingsuanUpperRow2';
  upperRow2.style.cssText = 'display:flex;gap:clamp(3px,0.8vw,8px);justify-content:center;align-items:center;';
  upperCardsWrap.appendChild(upperRow2);
  
  // 开始/结束按钮（A区左侧居中）
  const startBtn = document.createElement('button');
  startBtn.id = 'jingsuanStartBtn';
  startBtn.textContent = '开始';
  startBtn.style.cssText = 'padding:clamp(2px,0.5vh,4px) clamp(4px,1vw,10px);font-size:clamp(6px,1.2vw,8px);background:#f00;color:#fff;border:none;border-radius:3px;cursor:pointer;align-self:center;white-space:nowrap;';
  if (isCurrentPlayer) {
    startBtn.onclick = () => {
      socket.emit('jingsuanStartGame');
    };
  } else {
    startBtn.disabled = true;
    startBtn.style.opacity = '0.5';
  }
  upperArea.appendChild(startBtn);
  
  upperArea.appendChild(upperCardsWrap);
  
  panel.appendChild(upperArea);
  
  // B区（下半区域，分为上下两个半区）
  const lowerArea = document.createElement('div');
  lowerArea.id = 'jingsuanLowerArea';
  lowerArea.style.cssText = 'display:flex;flex-direction:column;margin-top:clamp(2px,0.5vh,6px);border-radius:6px;padding:clamp(2px,0.5vh,6px);flex:2;min-height:0;overflow:hidden;';
  
  // B区上半区
  const topZone = document.createElement('div');
  topZone.id = 'jingsuanTopZone';
  topZone.style.cssText = 'min-height:clamp(30px,8vh,80px);background:rgba(255,255,255,0.3);border-radius:6px;padding:clamp(1px,0.3vh,3px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:clamp(1px,0.3vh,2px);flex:1;min-height:0;overflow:hidden;';
  
  // B区上半区上排（最多5张）
  const topRow1 = document.createElement('div');
  topRow1.id = 'jingsuanTopRow1';
  topRow1.style.cssText = 'display:flex;gap:clamp(2px,0.5vw,3px);justify-content:center;align-items:center;';
  topZone.appendChild(topRow1);
  
  // B区上半区下排（最多5张）
  const topRow2 = document.createElement('div');
  topRow2.id = 'jingsuanTopRow2';
  topRow2.style.cssText = 'display:flex;gap:clamp(2px,0.5vw,3px);justify-content:center;align-items:center;';
  topZone.appendChild(topRow2);
  
  lowerArea.appendChild(topZone);
  
  // 白色分隔线（在B区上下两区域的中间）
  const divider = document.createElement('div');
  divider.id = 'jingsuanDivider';
  divider.style.cssText = 'width:100%;height:clamp(2px,0.5vh,4px);background:#fff;margin:clamp(1px,0.3vh,3px) 0;flex-shrink:0;';
  lowerArea.appendChild(divider);
  
  // B区下半区
  const bottomZone = document.createElement('div');
  bottomZone.id = 'jingsuanBottomZone';
  bottomZone.style.cssText = 'min-height:clamp(30px,8vh,80px);background:rgba(255,255,255,0.3);border-radius:6px;padding:clamp(1px,0.3vh,3px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:clamp(1px,0.3vh,2px);flex:1;min-height:0;overflow:hidden;';
  
  // B区下半区上排（最多5张）
  const bottomRow1 = document.createElement('div');
  bottomRow1.id = 'jingsuanBottomRow1';
  bottomRow1.style.cssText = 'display:flex;gap:clamp(2px,0.5vw,3px);justify-content:center;align-items:center;';
  bottomZone.appendChild(bottomRow1);
  
  // B区下半区下排（最多5张）
  const bottomRow2 = document.createElement('div');
  bottomRow2.id = 'jingsuanBottomRow2';
  bottomRow2.style.cssText = 'display:flex;gap:clamp(2px,0.5vw,3px);justify-content:center;align-items:center;';
  bottomZone.appendChild(bottomRow2);
  
  lowerArea.appendChild(bottomZone);
  panel.appendChild(lowerArea);
  
  // 关闭按钮（右上角红×，仅当前玩家显示，游戏结束后显示）
  if (isCurrentPlayer) {
    const closeBtn = document.createElement('div');
    closeBtn.id = 'jingsuanCloseBtn';
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'position:absolute;top:clamp(4px,1vh,10px);right:clamp(4px,1vh,10px);width:clamp(28px,5vh,40px);height:clamp(28px,5vh,40px);background:#f00;color:#fff;font-size:clamp(16px,3vh,24px);border-radius:50%;display:none;align-items:center;justify-content:center;cursor:pointer;';
    closeBtn.onclick = () => {
      socket.emit('jingsuanClose');
      // 关闭面板后在F区显示结束按钮
      const areaF = document.getElementById('areaF');
      if (areaF) {
        areaF.innerHTML = `<button id="endTurnBtn" class="jail-btn">结束</button>`;
        document.getElementById('endTurnBtn').onclick = () => {
          areaF.innerHTML = '';
          socket.emit('endTurn');
        };
      }
    };
    panel.appendChild(closeBtn);
  }
  
  document.body.appendChild(panel);
  
  // 先设置变量，再渲染
  window.jingsuanIsCurrentPlayer = isCurrentPlayer;
  window.jingsuanGameOver = false;
  window.jingsuanGameStarted = false;
  window.jingsuanCards = cards || []; // 保存牌数据
  window.jingsuanUpperCards = cards ? [...cards] : []; // A区牌（初始全部在A区）
  window.jingsuanTopZone = []; // B区上半区牌
  window.jingsuanBottomZone = []; // B区下半区牌
  window.jingsuanSelectedCard = null; // 当前选中的牌
  
  // 初始不渲染牌，点击开始后才显示
  // if (cards && cards.length === 9) {
  //   renderJingsuanCards();
  // }
  
  // 预加载牌图片
  if (cards && cards.length === 9) {
    cards.forEach(card => {
      const preload = new Image();
      preload.src = `/drawable/pukepai/${card.imageIndex}.png`;
    });
  }
});

// 渲染精算牌的函数
function renderJingsuanCards() {
  // 渲染A区
  const upperRow1 = document.getElementById('jingsuanUpperRow1');
  const upperRow2 = document.getElementById('jingsuanUpperRow2');
  
  upperRow1.innerHTML = '';
  window.jingsuanUpperCards.slice(0, 5).forEach((card, i) => {
    const cardEl = createJingsuanCard(card, i, 'upper');
    upperRow1.appendChild(cardEl);
  });
  
  upperRow2.innerHTML = '';
  window.jingsuanUpperCards.slice(5, 9).forEach((card, i) => {
    const cardEl = createJingsuanCard(card, i + 5, 'upper');
    upperRow2.appendChild(cardEl);
  });
  
  // 渲染B区上半区
  const topRow1 = document.getElementById('jingsuanTopRow1');
  const topRow2 = document.getElementById('jingsuanTopRow2');
  
  topRow1.innerHTML = '';
  window.jingsuanTopZone.slice(0, 5).forEach((card, i) => {
    const cardEl = createJingsuanCard(card, i, 'top');
    cardEl.style.cssText = 'width:clamp(28px,6vw,46px);height:clamp(38px,8vh,64px);border-radius:3px;cursor:pointer;overflow:hidden;position:relative;';
    topRow1.appendChild(cardEl);
  });
  
  topRow2.innerHTML = '';
  window.jingsuanTopZone.slice(5, 10).forEach((card, i) => {
    const cardEl = createJingsuanCard(card, i + 5, 'top');
    cardEl.style.cssText = 'width:clamp(28px,6vw,46px);height:clamp(38px,8vh,64px);border-radius:3px;cursor:pointer;overflow:hidden;position:relative;';
    topRow2.appendChild(cardEl);
  });
  
  // 渲染B区下半区
  const bottomRow1 = document.getElementById('jingsuanBottomRow1');
  const bottomRow2 = document.getElementById('jingsuanBottomRow2');
  
  bottomRow1.innerHTML = '';
  window.jingsuanBottomZone.slice(0, 5).forEach((card, i) => {
    const cardEl = createJingsuanCard(card, i, 'bottom');
    cardEl.style.cssText = 'width:clamp(28px,6vw,46px);height:clamp(38px,8vh,64px);border-radius:3px;cursor:pointer;overflow:hidden;position:relative;';
    bottomRow1.appendChild(cardEl);
  });
  
  bottomRow2.innerHTML = '';
  window.jingsuanBottomZone.slice(5, 10).forEach((card, i) => {
    const cardEl = createJingsuanCard(card, i + 5, 'bottom');
    cardEl.style.cssText = 'width:clamp(28px,6vw,46px);height:clamp(38px,8vh,64px);border-radius:3px;cursor:pointer;overflow:hidden;position:relative;';
    bottomRow2.appendChild(cardEl);
  });
}

// 创建精算牌元素
function createJingsuanCard(card, index, zone) {
  const cardEl = document.createElement('div');
  cardEl.className = 'jingsuan-card';
  cardEl.dataset.index = index;
  cardEl.dataset.zone = zone;
  cardEl.dataset.cardIndex = window.jingsuanCards.indexOf(card);
  cardEl.style.cssText = 'width:clamp(32px,7vw,56px);height:clamp(44px,10vh,78px);border-radius:clamp(2px,0.5vh,4px);cursor:pointer;overflow:hidden;position:relative;';
  
  const img = document.createElement('img');
  img.src = `/drawable/pukepai/${card.imageIndex}.png`;
  img.style.cssText = 'width:100%;height:100%;object-fit:contain;pointer-events:none;';
  cardEl.appendChild(img);
  
  // 点击事件（选中牌）
  if (window.jingsuanIsCurrentPlayer && !window.jingsuanGameOver && window.jingsuanGameStarted) {
    cardEl.onclick = (e) => {
      e.stopPropagation();
      handleJingsuanCardClick(card, index, zone);
    };
    
    // 拖拽事件
    cardEl.draggable = true;
    cardEl.ondragstart = (e) => {
      e.dataTransfer.setData('cardImageIndex', card.imageIndex);
      e.dataTransfer.setData('zone', zone);
      e.dataTransfer.setData('index', index);
    };
  }
  
  return cardEl;
}

// 处理牌点击事件
function handleJingsuanCardClick(card, index, zone) {
  if (!window.jingsuanGameStarted || window.jingsuanGameOver) return;
  
  // 如果已经选中了一张牌，点击另一个区域则移动
  if (window.jingsuanSelectedCard) {
    const selectedZone = window.jingsuanSelectedCard.zone;
    const selectedIndex = window.jingsuanSelectedCard.index;
    const selectedCard = window.jingsuanSelectedCard.card;
    
    // 如果点击的是同一个区域的同一张牌，取消选中
    if (zone === selectedZone && index === selectedIndex) {
      clearJingsuanSelection();
      return;
    }
    
    // 如果点击的是另一个区域，移动牌
    if (zone !== selectedZone) {
      moveJingsuanCard(selectedCard, selectedZone, zone);
      clearJingsuanSelection();
    }
  } else {
    // 选中这张牌
    window.jingsuanSelectedCard = { card, index, zone };
    highlightJingsuanCard(index, zone);
  }
}

// 高亮选中的牌
function highlightJingsuanCard(index, zone) {
  document.querySelectorAll('.jingsuan-card').forEach(el => {
    el.style.outline = '';
  });
  const cardEl = document.querySelector(`.jingsuan-card[data-zone="${zone}"][data-index="${index}"]`);
  if (cardEl) {
    cardEl.style.outline = '2px solid #fff'; cardEl.style.outlineOffset = '-2px';
  }
}

// 清除选中状态
function clearJingsuanSelection() {
  window.jingsuanSelectedCard = null;
  document.querySelectorAll('.jingsuan-card').forEach(el => {
    el.style.outline = '';
  });
}

// 用imageIndex查找card在jingsuanCards中的索引（避免对象引用不匹配）
function findJingsuanCardIndex(card) {
  if (!card) return -1;
  return window.jingsuanCards.findIndex(c => c.imageIndex === card.imageIndex);
}

// 用imageIndex匹配过滤（避免对象引用不匹配）
function filterCardByImageIndex(arr, card) {
  return arr.filter(c => c.imageIndex !== card.imageIndex);
}

// 移动牌
function moveJingsuanCard(card, fromZone, toZone) {
  // 从原区域移除（用imageIndex匹配）
  if (fromZone === 'upper') {
    window.jingsuanUpperCards = filterCardByImageIndex(window.jingsuanUpperCards, card);
  } else if (fromZone === 'top') {
    window.jingsuanTopZone = filterCardByImageIndex(window.jingsuanTopZone, card);
  } else if (fromZone === 'bottom') {
    window.jingsuanBottomZone = filterCardByImageIndex(window.jingsuanBottomZone, card);
  }
  
  // 添加到目标区域（最多10张）
  if (toZone === 'upper') {
    if (window.jingsuanUpperCards.length < 9) {
      window.jingsuanUpperCards.push(card);
    }
  } else if (toZone === 'top') {
    if (window.jingsuanTopZone.length < 10) {
      window.jingsuanTopZone.push(card);
    }
  } else if (toZone === 'bottom') {
    if (window.jingsuanBottomZone.length < 10) {
      window.jingsuanBottomZone.push(card);
    }
  }
  
  // 重新渲染
  renderJingsuanCards();
  
  // 发送更新到服务器
  socket.emit('jingsuanMoveCard', {
    cardIndex: findJingsuanCardIndex(card),
    fromZone,
    toZone
  });
}

// 在最后一张牌右侧显示点数
function showJingsuanSum(zone, sum) {
  const cards = zone === 'top' ? window.jingsuanTopZone : window.jingsuanBottomZone;
  const rowId = cards.length <= 5 
    ? (zone === 'top' ? 'jingsuanTopRow1' : 'jingsuanBottomRow1')
    : (zone === 'top' ? 'jingsuanTopRow2' : 'jingsuanBottomRow2');
  const row = document.getElementById(rowId);
  if (!row) return;
  
  // 找到该行最后一张牌
  const lastCard = row.querySelector('.jingsuan-card:last-child');
  if (lastCard) {
    const sumEl = document.createElement('span');
    sumEl.className = 'jingsuan-sum-label';
    sumEl.textContent = `点数:${sum}`;
    sumEl.style.cssText = `color:#fff;font-size:clamp(12px,2.5vw,20px);margin-left:clamp(3px,0.8vw,6px);white-space:nowrap;align-self:center;background:#000;padding:clamp(1px,0.3vh,2px) clamp(3px,0.8vw,6px);border-radius:4px;`;
    lastCard.style.position = 'relative';
    // 将点数插入到最后一张牌后面
    lastCard.parentNode.insertBefore(sumEl, lastCard.nextSibling);
  } else {
    // 没有牌时，在行内显示
    const sumEl = document.createElement('span');
    sumEl.className = 'jingsuan-sum-label';
    sumEl.textContent = `点数:${sum}`;
    sumEl.style.cssText = `color:#fff;font-size:clamp(12px,2.5vw,20px);margin-left:clamp(3px,0.8vw,6px);white-space:nowrap;align-self:center;background:#000;padding:clamp(1px,0.3vh,2px) clamp(3px,0.8vw,6px);border-radius:4px;`;
    row.appendChild(sumEl);
  }
}

// B区点击/拖放事件（使用事件委托，不依赖子元素）
function setupJingsuanZoneDrop() {
  const topZone = document.getElementById('jingsuanTopZone');
  const bottomZone = document.getElementById('jingsuanBottomZone');
  const upperArea = document.getElementById('jingsuanUpperArea');
  
  [topZone, bottomZone, upperArea].forEach(zone => {
    if (!zone) return;
    
    // 事件委托：dragover和drop绑定在zone上，子元素变化不影响
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      const cardImageIndex = parseInt(e.dataTransfer.getData('cardImageIndex'));
      const fromZone = e.dataTransfer.getData('zone');
      const cardIndex = window.jingsuanCards.findIndex(c => c.imageIndex === cardImageIndex);
      const card = window.jingsuanCards[cardIndex];
      if (!card || cardIndex === -1) return;
      
      let toZone = 'upper';
      if (zone === topZone) toZone = 'top';
      else if (zone === bottomZone) toZone = 'bottom';
      
      moveJingsuanCard(card, fromZone, toZone);
    });
    
    // 点击空白区域放置选中的牌
    zone.addEventListener('click', (e) => {
      // 只在点击zone本身或row时触发，点击牌不触发（牌有自己的onclick）
      if (e.target.closest('.jingsuan-card')) return;
      if (window.jingsuanSelectedCard) {
        const toZone = zone === topZone ? 'top' : (zone === bottomZone ? 'bottom' : 'upper');
        moveJingsuanCard(window.jingsuanSelectedCard.card, window.jingsuanSelectedCard.zone, toZone);
        clearJingsuanSelection();
      }
    });
  });
}

// 精算：游戏开始（服务器通知）
socket.on('jingsuanGameStarted', ({ currentPlayerId }) => {
  window.jingsuanGameStarted = true;
  
  // 更改按钮为结束按钮
  const startBtn = document.getElementById('jingsuanStartBtn');
  if (startBtn) {
    startBtn.textContent = '结束';
    startBtn.onclick = () => {
      socket.emit('jingsuanEndGame');
    };
  }
  
  // 重新渲染牌以绑定点击/拖动事件
  renderJingsuanCards();
  
  // 设置拖放区域
  setupJingsuanZoneDrop();
});

// 精算：时间更新
socket.on('jingsuanTimeUpdate', ({ timeLeft }) => {
  if (!window.jingsuanGameStarted) return;
  
  const timeline = document.getElementById('jingsuanTimeline');
  if (timeline) {
    timeline.style.width = `${(timeLeft / 18) * 100}%`;
  }
});

// 精算：牌状态更新
socket.on('jingsuanUpdate', ({ upperCards, topZone, bottomZone }) => {
  // 检查状态是否真的变了，避免重复渲染
  const upperChanged = !arraysEqualByImageIndex(window.jingsuanUpperCards, upperCards);
  const topChanged = !arraysEqualByImageIndex(window.jingsuanTopZone, topZone);
  const bottomChanged = !arraysEqualByImageIndex(window.jingsuanBottomZone, bottomZone);
  
  window.jingsuanUpperCards = upperCards || [];
  window.jingsuanTopZone = topZone || [];
  window.jingsuanBottomZone = bottomZone || [];
  
  // 同步更新jingsuanCards的对象引用
  const allNewCards = [...window.jingsuanUpperCards, ...window.jingsuanTopZone, ...window.jingsuanBottomZone];
  window.jingsuanCards = window.jingsuanCards.map(oldCard => {
    const newCard = allNewCards.find(c => c.imageIndex === oldCard.imageIndex);
    return newCard || oldCard;
  });
  
  if (upperChanged || topChanged || bottomChanged) {
    renderJingsuanCards();
  }
});

// 比较两个card数组是否相同（按imageIndex）
function arraysEqualByImageIndex(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].imageIndex !== b[i].imageIndex) return false;
  }
  return true;
}

// 精算：结果显示
socket.on('jingsuanResult', ({ success, topSum, bottomSum, totalCards, playerId, playerName, playerColor, reward }) => {
  window.jingsuanGameOver = true;
  
  // 禁用所有牌和按钮的点击
  document.querySelectorAll('.jingsuan-card').forEach(el => {
    el.style.cursor = 'default';
    el.onclick = null;
    el.ondragstart = null;
    el.draggable = false;
  });
  
  // 隐藏开始/结束按钮
  const startBtn = document.getElementById('jingsuanStartBtn');
  if (startBtn) startBtn.style.display = 'none';
  
  // 显示点数（在最后一张牌右侧）
  showJingsuanSum('top', topSum);
  showJingsuanSum('bottom', bottomSum);
  
  // 显示关闭按钮（仅当前玩家）
  if (window.jingsuanIsCurrentPlayer) {
    const closeBtn = document.getElementById('jingsuanCloseBtn');
    if (closeBtn) {
      closeBtn.style.display = 'flex';
    }
  }
});

// 精算：关闭面板
socket.on('jingsuanPanelClose', () => {
  const panel = document.getElementById('jingsuanPanel');
  if (panel) panel.remove();
});

socket.on('qiyuAnduchengcangStart', ({ playerId, playerName, playerColor, hasTarget, targets }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  
  areaF.innerHTML = `<button id="qiyuAnduchengcangBtn" class="jail-btn">暗度陈仓</button><button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('qiyuAnduchengcangBtn').onclick = () => {
    if (!hasTarget) {
      $('areaE').innerHTML = '地产不够2';
      areaF.innerHTML = `<button id="endTurnBtn" class="jail-btn">结束</button>`;
      document.getElementById('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
      return;
    }
    areaF.innerHTML = '';
    $('areaE').innerHTML = '请选择目标玩家';
    qiyuAnduchengcangSelectingTarget = true;
    window.qiyuAnduchengcangTargets = targets;
    render();
    refreshPlayerCards();
    checkNoValidTarget();
  };
  document.getElementById('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

socket.on('qiyuAnduchengcangSelectProp', ({ currentPlayerId, targetId, targetName, targetColor, properties }) => {
  if (myId !== currentPlayerId && myId !== targetId) return;
  qiyuAnduchengcangSelectingTarget = false;
  qiyuAnduchengcangSelectingProp = true;
  window.qiyuAnduchengcangCurrentPlayerId = currentPlayerId;
  window.qiyuAnduchengcangTargetId = targetId;
  window.qiyuAnduchengcangProperties = properties;
  $('areaE').innerHTML = '请选择地产';
  render();
});

socket.on('qiyuAnduchengcangPropSelected', () => {
  document.getElementById('areaF').innerHTML = '';
});

socket.on('qiyuQiankundanayiStart', ({ playerId, playerName, playerColor, hasTarget }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  
  if (!hasTarget) {
    $('areaE').innerHTML = '没有合适的目标';
    areaF.innerHTML = `<button id="endTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('endTurnBtn').onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    return;
  }
  
  qiyuQiankundanayiSelectingTarget = true;
  render();
  refreshPlayerCards();
  checkNoValidTarget();
});

socket.on('qiyuTapieStart', ({ playerId, playerName, playerColor }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="qiyuTapieBtn" class="jail-btn">铁鞋</button><button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('qiyuTapieBtn').onclick = () => {
    areaF.innerHTML = `<button id="endTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('endTurnBtn').onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    socket.emit('qiyuTapieConfirm');
  };
  document.getElementById('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

socket.on('qiyuYanxueStart', ({ playerId, playerName, playerColor }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="qiyuYanxueHospitalBtn" class="jail-btn">到医院</button><button id="qiyuYanxueMinusBtn" class="jail-btn">-8</button>`;
  document.getElementById('qiyuYanxueHospitalBtn').onclick = () => {
    areaF.innerHTML = `<button id="endTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('endTurnBtn').onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    socket.emit('qiyuYanxueChoice', { choice: 'hospital' });
  };
  document.getElementById('qiyuYanxueMinusBtn').onclick = () => {
    areaF.innerHTML = `<button id="endTurnBtn" class="jail-btn">结束</button>`;
    document.getElementById('endTurnBtn').onclick = () => {
      areaF.innerHTML = '';
      socket.emit('endTurn');
    };
    socket.emit('qiyuYanxueChoice', { choice: 'minus8' });
  };
});

socket.on('qiyuJietouDouru', ({ playerId, playerName, playerColor, qiyu, hasTarget }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="qiyuJietouDouruBtn" class="jail-btn">斗殴</button><button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('qiyuJietouDouruBtn').onclick = () => {
    if (!hasTarget) {
      $('areaE').innerHTML = '没有合适的目标';
      areaF.innerHTML = `<button id="endTurnBtn" class="jail-btn">结束</button>`;
      document.getElementById('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
      return;
    }
    areaF.innerHTML = '';
    $('areaE').innerHTML = '请选择目标玩家';
    qiyuJietouDouruSelectingTarget = true;
    render();
    refreshPlayerCards();
    checkNoValidTarget();
  };
  document.getElementById('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

socket.on('qiyuBanzhuanDaren', ({ playerId, playerName, playerColor, qiyu, hasProperty }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="qiyuBanzhuanDarenBtn" class="jail-btn">搬砖</button><button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('qiyuBanzhuanDarenBtn').onclick = () => {
    if (!hasProperty) {
      $('areaE').innerHTML = '没有合适的地产或金钱不足';
      areaF.innerHTML = `<button id="endTurnBtn" class="jail-btn">结束</button>`;
      document.getElementById('endTurnBtn').onclick = () => {
        areaF.innerHTML = '';
        socket.emit('endTurn');
      };
      return;
    }
    areaF.innerHTML = '';
    $('areaE').innerHTML = '请选择自己的地产升级';
    qiyuBanzhuanDarenSelectingProp = true;
    render();
  };
  document.getElementById('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

socket.on('qiyuTiemen', ({ playerId, playerName, playerColor, qiyu, hasKey }) => {
  if (myId !== playerId) return;
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="qiyuTiemenBtn" class="jail-btn">铁门</button><button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('qiyuTiemenBtn').onclick = () => {
    document.getElementById('qiyuTiemenBtn').remove();
    if (!hasKey) {
      $('areaE').innerHTML = '没有钥匙开门';
      fitAreaEText();
    } else {
      areaF.innerHTML = '';
      socket.emit('qiyuTiemenConfirm');
    }
  };
  document.getElementById('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

socket.on('qiyuYinmen', ({ playerId, playerName, playerColor, qiyu, hasKey }) => {
  if (myId !== playerId) return;
  $('areaE').innerHTML = `${qiyu.name}:${qiyu.desc}`;
  fitAreaEText();
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="qiyuYinmenBtn" class="jail-btn">银门</button><button id="endTurnBtn" class="jail-btn">结束</button>`;
  document.getElementById('qiyuYinmenBtn').onclick = () => {
    document.getElementById('qiyuYinmenBtn').remove();
    if (!hasKey) {
      $('areaE').innerHTML = '没有钥匙开门';
      fitAreaEText();
    } else {
      areaF.innerHTML = '';
      socket.emit('qiyuYinmenConfirm');
    }
  };
  document.getElementById('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

socket.on('jinzuStay', () => {
  const areaG = $('areaG');
  if (areaG) {
    areaG.innerHTML = '';
    areaG.style.cursor = 'default';
    areaG.onclick = null;
  }
});

socket.on('hezongFail', (msg) => {
  selectingHezongTarget = false;
  waitingHezongTarget = false;
  hezongPlayerIds = [];
  document.getElementById('areaF').innerHTML = '';
  if (msg) { $('areaE').innerHTML = msg; fitAreaEText(); }
  render();
});

socket.on('hezongTimeout', () => {
  selectingHezongTarget = false;
  waitingHezongTarget = false;
  hezongPlayerIds = [];
  const cur = players[currentPlayerIdx];
  const isMyTurn = cur?.id === myId && !cur?.bankrupt;
  updateGAreaDiceImage(0, isMyTurn);
  render();
});

let kunlunProgress = 0;
let kunlunPlayerId = null;
let kunlunPlayerColor = null;

let diamondCircleProgress = 0;
let diamondCirclePlayerId = null;
let diamondCirclePlayerColor = null;

socket.on('diamondProgressUpdate', ({ playerId, playerColor, progress }) => {
  diamondCirclePlayerId = playerId;
  diamondCirclePlayerColor = playerColor;
  diamondCircleProgress = progress;
  renderBoardOnly();
});

socket.on('diamondRedeemed', ({ playerName, playerColor }) => {
  showPopupMessage(`<img src="/drawable/ditu/zuanshi.png" style="width:clamp(80px,20vw,130px);height:clamp(80px,20vw,130px);object-fit:contain;flex-shrink:0;"><div style="background:#000;color:#fff;padding:8px 16px;border-radius:6px;font-size:clamp(24px,6vw,40px);">${coloredName(playerName, playerColor)}成功兑换钻石，+20，工资+3</div>`);
});

socket.on('kunlunArrive', ({ playerId, playerName, playerColor, progress }) => {
  kunlunPlayerId = playerId;
  kunlunPlayerColor = playerColor;
  kunlunProgress = progress;
  renderBoardOnly();
  reattachSansiPanel();
});

socket.on('kunlunProgress', ({ playerId, progress }) => {
  kunlunProgress = progress;
  renderBoardOnly();
  reattachSansiPanel();
});

socket.on('kunlunPanel', ({ playerId, playerName, playerColor, options }) => {
  const isMyTurn = playerId === myId;
  const me = players.find(p => p.id === myId);
  const hasKey = me && me.cards && me.cards.some(c => c.name === '钥匙');
  const hasRemovableStatus = me && (
    (me.extraTurns > 0) || me.fuwufeiExtraMove || (me.restTurns > 0) || me.sheltered || me.shihua ||
    me.guhuoDice || me.shoumaiDice || me.yinyueDice || me.shijieWar ||
    (me.hezongState === 'forced' || me.hezongState === 'normal') ||
    (me.diceEffects && me.diceEffects.length > 0) || me.daotui || (me.bingdong > 0) ||
    me.bomingFrozen || me.jinzu || (me.tuolei && me.tuolei.turns > 0) || me.wenjigifwu ||
    (me.dizhuTurns > 0) || (me.fengkongDice && me.fengkongDice.length > 0) || me.syncedDice ||
    (me.cunqianList && me.cunqianList.length > 0)
  );
  const optionDefs = options.map(opt => {
    const needsKey = opt === '昆仑之门【需钥匙】：+40';
    const needsStatus = opt === '随机移除1项状态';
    const disabled = !isMyTurn || (needsKey && !hasKey) || (needsStatus && !hasRemovableStatus);
    return { label: opt, disabled, callback: () => { socket.emit('kunlunSelect', { option: opt }); } };
  });
  showTck('/drawable/ditu/kunlun.png', '昆仑仙人赐福，请选择一项强化', optionDefs);
});

socket.on('kunlunDiceChoice', ({ playerId, diceOptions }) => {
  clearTips();
  
  const areaG = $('areaG');
  if (areaG) { areaG.innerHTML = ''; areaG.style.cursor = 'default'; areaG.onclick = null; }
  
  $('areaE').textContent = '请选择一个点数';
  
  const isMyTurn = playerId === myId;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `
    <button class="kunlun-dice-btn jail-btn" data-dice="${diceOptions[0]}" ${!isMyTurn ? 'disabled style="opacity:0.5"' : ''}>${diceOptions[0]}</button>
    <button class="kunlun-dice-btn jail-btn" data-dice="${diceOptions[1]}" ${!isMyTurn ? 'disabled style="opacity:0.5"' : ''}>${diceOptions[1]}</button>
  `;
  
  if (isMyTurn) {
    document.querySelectorAll('.kunlun-dice-btn').forEach(btn => {
      btn.onclick = () => {
        const diceValue = parseInt(btn.dataset.dice);
        socket.emit('kunlunDiceSelect', { diceValue });
        areaF.innerHTML = '';
        $('areaE').textContent = '';
      };
    });
  }
});

socket.on('kunlunPropertySelect', ({ playerId }) => {
  const isMyTurn = playerId === myId;
  $('areaE').textContent = '请点击地图上的一块地产';
  document.getElementById('areaF').innerHTML = '';
  
  const areaG = $('areaG');
  if (areaG) { areaG.innerHTML = ''; areaG.style.cursor = 'default'; areaG.onclick = null; }
  
  if (isMyTurn) {
    initKunlunPropertyClick();
  }
});

function initKunlunPropertyClick() {
  document.querySelectorAll('.space').forEach(spaceEl => {
    const spaceId = parseInt(spaceEl.dataset.id);
    const space = board.find(s => s.id === spaceId);
    if (space && space.isProperty === true) {
      spaceEl.style.cursor = 'pointer';
      spaceEl.onclick = () => {
        socket.emit('kunlunPropertySelectDone', { propertyId: spaceId });
        document.querySelectorAll('.space').forEach(s => {
          s.style.cursor = '';
        });
      };
    }
  });
}

socket.on('closeKunlunTck', () => {
  // 从tckQueue中移除所有kunlunTip
  const newQueue = [];
  for (let i = 0; i < tckQueue.length; i++) {
    const t = tckQueue[i];
    try {
      if (t.el && t.el.id === 'kunlunTip') continue;
      newQueue.push(t);
    } catch(e) {}
  }
  tckQueue.length = 0;
  for (let i = 0; i < newQueue.length; i++) {
    tckQueue.push(newQueue[i]);
  }
  const tckOverlay = document.getElementById('tckOverlay');
  if (tckOverlay) {
    tckOverlay.innerHTML = '';
    if (tckQueue.length === 0) {
      tckOverlay.style.display = 'none';
    } else {
      for (let i = tckQueue.length - 1; i >= 0; i--) {
        try { tckOverlay.appendChild(tckQueue[i].el); } catch(e) {}
      }
      tckOverlay.style.display = 'flex';
    }
  }
});

socket.on('kunlunResult', ({ playerId, playerName, playerColor, option }) => {
  // 从tckQueue中移除所有kunlunTip
  const newQueue = [];
  for (let i = 0; i < tckQueue.length; i++) {
    const t = tckQueue[i];
    try {
      if (t.el && t.el.id === 'kunlunTip') continue;
      newQueue.push(t);
    } catch(e) {}
  }
  tckQueue.length = 0;
  for (let i = 0; i < newQueue.length; i++) {
    tckQueue.push(newQueue[i]);
  }
  const tckOverlay = document.getElementById('tckOverlay');
  if (tckOverlay) {
    tckOverlay.innerHTML = '';
    if (tckQueue.length === 0) {
      tckOverlay.style.display = 'none';
    } else {
      for (let i = tckQueue.length - 1; i >= 0; i--) {
        try { tckOverlay.appendChild(tckQueue[i].el); } catch(e) {}
      }
      tckOverlay.style.display = 'flex';
    }
  }
  $('areaE').innerHTML = `${coloredName(playerName, playerColor)}选择了${option}`;
});

socket.on('sansiCannotSelect', ({ targetName, targetColor }) => {
  flyTargetHighlight = null;
  sansiPanelState = null;
  const panel = document.getElementById('sansiPanel');
  if (panel) panel.remove();

  $('areaE').innerHTML = `${coloredName(targetName, targetColor)}无法进行三思`;
  fitAreaEText();

  const cur = players[currentPlayerIdx];
  const isMyTurn = cur?.id === myId && !cur?.bankrupt;
  if (isMyTurn) {
    document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    const endTurnBtn = document.getElementById('endTurnBtn');
    if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
  }
  updateGAreaDiceImage(currentDiceValue, isMyTurn);
});

socket.on('petShopPanel', ({ playerId, gifIndex }) => {
  const boardEl = $('board');
  if (!boardEl) return;

  const isMyTurn = playerId === myId;

  const panel = document.createElement('div');
  panel.id = 'petShopPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;background:url(/drawable/bj4.png) center/cover no-repeat;';

  let html = '<div style="position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;width:90%;max-width:400px;height:90%;max-height:100%;">';
  if (isMyTurn) {
    html += '<div style="position:absolute;top:-8px;right:-8px;width:20px;height:20px;background:#e74c3c;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:12px;font-weight:bold;line-height:1;z-index:10;" id="petShopClose">×</div>';
  }

  html += '<div style="flex:1;min-height:0;width:100%;overflow:hidden;position:relative;border-radius:8px;">';
  html += `<video id="petShopAnim" src="/drawable/chongwu/chongwu2/dw${gifIndex}.mp4?t=${Date.now()}" autoplay muted playsinline loop style="width:100%;height:100%;object-fit:contain;"></video>`;
  html += '</div>';

  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;width:100%;flex-shrink:0;">';
  const options = ['宠物', '自选卡', '空地', '自有资产'];
  const emptyProps = board.filter(s => s.isProperty && !s.owner);
  const mePlayer = players.find(p => p.id === myId);
  const hasAnyAsset = mePlayer && (
    (mePlayer.petImage) ||
    (mePlayer.hasDiamond) ||
    (mePlayer.cards && mePlayer.cards.length > 0) ||
    board.some(s => s.isProperty && s.owner === mePlayer.id)
  );
  options.forEach(opt => {
    let disabled = !isMyTurn;
    if (opt === '空地' && emptyProps.length === 0) disabled = true;
    if (opt === '自有资产' && !hasAnyAsset) disabled = true;
    html += `<button class="pet-shop-btn jail-btn" data-option="${opt}" style="min-height:36px;font-size:16px;" ${disabled ? 'disabled' : ''}>${opt}</button>`;
  });
  html += '</div>';

  html += '</div>';

  panel.innerHTML = html;
  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);

  if (isMyTurn) {
    const closeBtn = document.getElementById('petShopClose');
    if (closeBtn) {
      closeBtn.onclick = () => socket.emit('petShopClose');
    }
    document.querySelectorAll('.pet-shop-btn:not([disabled])').forEach(btn => {
      btn.onclick = () => {
        const option = btn.dataset.option;
        if (option === '自选卡') {
          panel.remove();
          socket.emit('petShopSelect', { option });
          return;
        }
        if (option === '空地') {
          panel.remove();
          socket.emit('petShopSelect', { option });
          return;
        }
        if (option === '自有资产') {
          panel.remove();
          showMyAssetPanel();
          return;
        }
        socket.emit('petShopSelect', { option });
        panel.remove();
      };
    });
  }
});

socket.on('petShopEmptyProps', ({ playerId, properties }) => {
  const isMyTurn = playerId === myId;
  selectingPetShopEmptyProp = true;
  renderBoardOnly();
  $('areaE').innerHTML = '请点击一块空地进行拍卖';
  document.querySelectorAll('.space').forEach(spaceEl => {
    const spaceId = parseInt(spaceEl.dataset.id);
    const isEmpty = properties.some(p => p.id === spaceId);
    if (isEmpty) {
      spaceEl.style.border = '3px solid white';
      spaceEl.style.cursor = 'pointer';
      spaceEl.onclick = () => {
        selectingPetShopEmptyProp = false;
        renderBoardOnly();
        document.querySelectorAll('.space').forEach(s => {
          s.style.border = '';
          s.style.cursor = '';
          s.onclick = null;
        });
        $('areaE').innerHTML = '';
        socket.emit('petShopPropertyAuction', { propertyId: spaceId });
      };
    }
  });
});

socket.on('petShopEmptyPropEnd', () => {
  selectingPetShopEmptyProp = false;
  renderBoardOnly();
});

socket.on('petShopCardGrid', ({ playerId, cards }) => {
  const isMyTurn = playerId === myId;
  if (!isMyTurn) return;

  const panel = document.createElement('div');
  panel.id = 'petShopCardPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,1);padding:8px;box-sizing:border-box;overflow:hidden;';

  const boardEl = $('board');
  if (boardEl) {
    boardEl.style.position = 'relative';
    boardEl.appendChild(panel);
  }

  let selectedCardId = null;

  requestAnimationFrame(() => {
    const panelH = panel.clientHeight;
    const panelW = panel.clientWidth;
    const bottomRowH = 60;
    const gridH = panelH - bottomRowH - 16;
    const cols = Math.ceil(Math.sqrt(cards.length * (panelW / gridH)));
    const cardSize = Math.floor(Math.min((panelW - 16) / cols, gridH / Math.ceil(cards.length / cols)));

    let html = `<div id="cardGridArea" style="flex:1;display:flex;flex-wrap:wrap;gap:4px;justify-content:center;align-content:flex-start;overflow-y:auto;overflow-x:hidden;padding-bottom:8px;-webkit-overflow-scrolling:touch;scrollbar-width:none;-ms-overflow-style:none;">`;
    html += '<style>#cardGridArea::-webkit-scrollbar{display:none;}</style>';
    cards.forEach(card => {
      html += `<img src="/drawable/kapian/${card.image}.png" data-card-id="${card.id}" data-card-desc="${card.description}" style="width:${cardSize}px;height:${cardSize}px;object-fit:contain;cursor:pointer;border-radius:4px;border:2px solid transparent;transition:border-color 0.2s;" class="pet-grid-card">`;
    });
    html += '</div>';
    html += '<div id="cardBottomRow" style="height:60px;min-height:60px;display:flex;align-items:center;gap:8px;width:100%;padding:0 4px;">';
    html += '<div id="cardDesc" style="flex:1;color:#fff;font-size:14px;text-align:center;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.3;"></div>';
    html += '<button id="cardConfirmBtn" class="jail-btn" style="padding:4px 12px;border-radius:8px;opacity:0.5;font-size:14px;" disabled>确定</button>';
    html += '</div>';
    panel.innerHTML = html;

    document.querySelectorAll('.pet-grid-card').forEach(img => {
      img.onclick = () => {
        document.querySelectorAll('.pet-grid-card').forEach(i => i.style.borderColor = 'transparent');
        img.style.borderColor = '#f1c40f';
        selectedCardId = parseInt(img.dataset.cardId);
        $('cardDesc').textContent = img.dataset.cardDesc || '';
        const btn = $('cardConfirmBtn');
        btn.disabled = false;
        btn.style.opacity = '1';
      };
    });

    $('cardConfirmBtn').onclick = () => {
      if (selectedCardId !== null) {
        console.log('DEBUG petShopCardAuction emit: cardId=' + selectedCardId);
        socket.emit('petShopCardAuction', { cardId: selectedCardId });
        panel.remove();
        console.log('DEBUG petShopCardGrid panel removed');
      } else {
        console.log('DEBUG cardConfirmBtn clicked but selectedCardId is null');
      }
    };

    const gridArea = $('cardGridArea');
    if (gridArea) {
      let startY = 0;
      let startScrollTop = 0;
      let isDragging = false;
      gridArea.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY;
        startScrollTop = gridArea.scrollTop;
        isDragging = true;
      }, { passive: true });
      gridArea.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const y = e.touches[0].clientY;
        const dy = startY - y;
        gridArea.scrollTop = startScrollTop + dy;
      }, { passive: true });
      gridArea.addEventListener('touchend', () => {
        isDragging = false;
      }, { passive: true });
    }
  });
});

socket.on('kunlunNewCycle', ({ playerId, progress }) => {
  kunlunProgress = progress;
  renderBoardOnly();
});

socket.on('kunlunStartTurn', ({ playerId }) => {
  restoreMoneyIndicators();
});

let sansiSelectingTarget = false;
let sansiPanelState = null;
let extraTurnPlayerId = null;
let flyTargetHighlight = null;
const propertyOpts = ['令1块地停业，给该玩家4', '令1块地停业，冻结13', '+35，地产-1', '+8，地产路费-2', '骰子+1，地产路费-2', '和下家一起+6，地产路费-1', '现金补充到最近的10的倍数，地产路费-1', '地产路费+2，给每人4', '地产-1，随机获得4张卡片', '地产-1，工资+10'];

function reattachSansiPanel() {
  if (!sansiPanelState) {
    return;
  }
  if (selectingPropertyEffect || selectingPropertyClosed) {
    const panel = document.getElementById('sansiPanel');
    if (panel) {
      const msg = selectingPropertyClosed ? '请选择一块有地主的地产停业' : '请选择你的一块地产';
      panel.innerHTML = `<div style="color:#000;font-size:20px;background:rgba(255,255,255,0.5);padding:10px 20px;border-radius:8px;">${msg}</div>`;
    }
    return;
  }
  const boardEl = $('board');
  if (!boardEl) return;
  const existing = document.getElementById('sansiPanel');
  if (existing) {
    return;
  }

  const panel = document.createElement('div');
  panel.id = 'sansiPanel';
  panel.style.position = 'absolute';
  panel.style.top = '0';
  panel.style.left = '0';
  panel.style.right = '0';
  panel.style.bottom = '0';
  panel.style.zIndex = '100';
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.alignItems = 'center';
  panel.style.justifyContent = 'center';
  panel.style.background = 'transparent';
  panel.style.pointerEvents = 'auto';

  const s = sansiPanelState;
  const isMyTurn = s.playerId === myId;

  if (s.phase === 'selectFlyTarget') {
    panel.innerHTML = `<div style="color:#000;font-size:20px;background:rgba(255,255,255,0.5);padding:10px 20px;border-radius:8px;">请选择5格内任一格</div>`;
  } else if (s.phase === 'selectTarget') {
    panel.innerHTML = `<div style="color:#000;font-size:20px;background:rgba(255,255,255,0.5);padding:10px 20px;border-radius:8px;">请点击角色信息区选择目标</div>`;
  } else if (s.phase === 'select' || s.phase === 'selectRestTarget' || s.phase === 'otherSelectRestTarget') {
    let btnsHtml = '';
    const opts = s.selectedOption ? s.remainingOptions : s.options;
    opts.forEach(opt => {
      btnsHtml += `<button class="sansi-option-btn jail-btn" data-option="${opt}" disabled style="opacity:0.5">${opt}</button>`;
    });
    panel.style.display = 'flex';
    panel.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 12px; pointer-events: auto;">
        ${btnsHtml}
      </div>
    `;
    if (!s.selectedOption && isMyTurn) {
      setTimeout(() => {
        document.querySelectorAll('.sansi-option-btn').forEach(btn => {
          btn.disabled = false;
          btn.style.opacity = '1';
          btn.onclick = () => {
            const option = btn.dataset.option;
            if (sansiPanelState) {
              sansiPanelState.selectedOption = option;
              sansiPanelState.remainingOptions = sansiPanelState.options.filter(o => o !== option);
              sansiPanelState.phase = 'selectTarget';
            }
            socket.emit('sansiSelect', { option });
            if (option === '随机飞' || option === '+5，后退5步' || option === '解冻，后退3步' || option === '倒退卡+1，后退7步' || option === '飞到5格内任一格' || option === '前进1步，给地产最少的6' || propertyOpts.includes(option)) {
              document.querySelectorAll('.sansi-option-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
            } else {
              btn.remove();
              document.querySelectorAll('.sansi-option-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
            }
          };
        });
      }, 0);
    }
  } else if (s.phase === 'otherSelect') {
    const isTarget = s.targetId === myId;
    let btnsHtml = '';
    s.remainingOptions.forEach(opt => {
      btnsHtml += `<button class="sansi-option-btn jail-btn" data-option="${opt}" ${!isTarget ? 'disabled style="opacity:0.5"' : ''}>${opt}</button>`;
    });
    panel.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 12px; pointer-events: auto;">
        ${btnsHtml}
      </div>
    `;
    if (isTarget) {
      setTimeout(() => {
        document.querySelectorAll('.sansi-option-btn:not([disabled])').forEach(btn => {
          btn.onclick = () => {
            const option = btn.dataset.option;
            socket.emit('sansiOtherSelect', { option });
          };
        });
      }, 0);
    }
  }

  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);
}

socket.on('sansiPanel', ({ playerId, playerName, playerColor, options }) => {
  const boardEl = $('board');
  if (!boardEl) return;

  const areaG = $('areaG');
  if (areaG) { areaG.innerHTML = ''; areaG.style.cursor = 'default'; areaG.onclick = null; }
  document.getElementById('areaF').innerHTML = '';

  sansiPanelState = { playerId, playerName, playerColor, options, phase: 'select', selectedOption: null, remainingOptions: [], targetId: null, targetName: null, targetColor: null, hidden: false };

  const panel = document.createElement('div');
  panel.id = 'sansiPanel';
  panel.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;background-image:url(/drawable/bj1.jpg);background-size:cover;background-position:center;padding:15px;border-radius:12px;width:320px;cursor:move;user-select:none;box-sizing:border-box;';

  const isMyTurn = playerId === myId;
  const me = players.find(p => p.id === myId);
  const myHasDiamond = me && me.hasDiamond;
  const myHasKey = me && me.cards && me.cards.some(c => c.id === 13);
  const myHasPet = me && !!me.petImage;
  const myHasProperty = me && board.some(s => s.isProperty && s.owner === myId);

  const btnsContainer = document.createElement('div');
  btnsContainer.style.cssText = 'display:flex;flex-direction:column;gap:6px;align-items:center;';

  options.forEach(opt => {
    let optDisabled = !isMyTurn;
    if (isMyTurn) {
      if (opt === '将你的钻石转换为随机2张卡' && !myHasDiamond) optDisabled = true;
    }
    const btn = document.createElement('button');
    btn.className = 'sansi-option-btn jail-btn';
    btn.dataset.option = opt;
    btn.textContent = opt;
    btn.style.cssText = 'white-space:nowrap;font-size:14px;padding:6px 10px;';
    if (optDisabled) {
      btn.disabled = true;
      btn.style.opacity = '0.5';
    }
    btnsContainer.appendChild(btn);
  });

  panel.appendChild(btnsContainer);

  panel.dataset.dragging = 'false';
  panel.dataset.offsetX = '0';
  panel.dataset.offsetY = '0';

  const startDrag = (clientX, clientY) => {
    const rect = panel.getBoundingClientRect();
    panel.dataset.dragging = 'true';
    panel.dataset.offsetX = clientX - rect.left;
    panel.dataset.offsetY = clientY - rect.top;
    panel.style.position = 'fixed';
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.transform = 'none';
  };

  const moveDrag = (clientX, clientY) => {
    if (panel.dataset.dragging !== 'true') return;
    panel.style.left = (clientX - parseFloat(panel.dataset.offsetX)) + 'px';
    panel.style.top = (clientY - parseFloat(panel.dataset.offsetY)) + 'px';
  };

  const endDrag = () => {
    panel.dataset.dragging = 'false';
  };

  panel.onmousedown = (e) => {
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    startDrag(e.clientX, e.clientY);
  };

  panel.ontouchstart = (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const touch = e.touches[0];
    startDrag(touch.clientX, touch.clientY);
  };

  const onMouseMove = (e) => moveDrag(e.clientX, e.clientY);
  const onMouseUp = () => endDrag();
  const onTouchMove = (e) => {
    const touch = e.touches[0];
    moveDrag(touch.clientX, touch.clientY);
  };
  const onTouchEnd = () => endDrag();

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('touchmove', onTouchMove);
  document.addEventListener('touchend', onTouchEnd);

  const observer = new MutationObserver(() => {
    const existing = document.getElementById('sansiPanel');
    if (!existing) {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      observer.disconnect();
    }
  });
  observer.observe(boardEl, { childList: true });

  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);

  if (isMyTurn) {
    document.querySelectorAll('.sansi-option-btn:not([disabled])').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const option = btn.dataset.option;
        if (sansiPanelState) {
          sansiPanelState.selectedOption = option;
          sansiPanelState.remainingOptions = sansiPanelState.options.filter(o => o !== option);
          sansiPanelState.phase = 'selectTarget';
        }
        socket.emit('sansiSelect', { option });
        if (option === '随机飞' || option === '+5，后退5步' || option === '解冻，后退3步' || option === '倒退卡+1，后退7步' || option === '飞到5格内任一格' || option === '前进1步，给地产最少的6' || propertyOpts.includes(option)) {
          document.querySelectorAll('.sansi-option-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
        } else {
          btn.remove();
          document.querySelectorAll('.sansi-option-btn').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
        }
      };
    });
  }
});

socket.on('sansiSelectFlyTarget', ({ playerId, fromPos, validPositions }) => {
  if (sansiPanelState) {
    sansiPanelState.phase = 'selectFlyTarget';
  }
  const panel = document.getElementById('sansiPanel');
  if (panel) {
    panel.innerHTML = `<div style="color:#000;font-size:20px;background:rgba(255,255,255,0.5);padding:10px 20px;border-radius:8px;">请选择5格内任一格</div>`;
  }

  $('areaE').innerHTML = '请选择5格内任一格';
  flyTargetHighlight = validPositions;

  document.querySelectorAll('.space').forEach(spaceEl => {
    const spaceId = parseInt(spaceEl.dataset.id);
    if (validPositions.includes(spaceId)) {
      spaceEl.style.border = '3px solid yellow';
      spaceEl.style.cursor = 'pointer';
      spaceEl.onclick = () => {
        flyTargetHighlight = null;
        document.querySelectorAll('.space').forEach(s => {
          s.style.border = '';
          s.style.cursor = '';
          s.onclick = null;
        });
        $('areaE').innerHTML = '';
        socket.emit('sansiFlyTarget', { targetPos: spaceId });
      };
    }
  });
});

socket.on('sansiSelectRestTarget', ({ playerId, option }) => {
  if (playerId === myId) {
    sansiSelectingTarget = true;
    if (sansiPanelState) {
      sansiPanelState.phase = sansiPanelState.phase === 'otherSelect' ? 'otherSelectRestTarget' : 'selectRestTarget';
    }
    let msg = '请选择角色';
    if (option === '上家休息1回合，-5' || option === '下家休息1回合，和上家一起-4') {
      msg = '请选择角色休息';
    } else if (option === '上家进医院，冻结14') {
      msg = '请选择角色进医院';
    } else if (option === '和下家一起进监狱') {
      msg = '请选择角色一起进监狱';
    }
    $('areaE').innerHTML = msg;
    const panel = document.getElementById('sansiPanel');
    if (panel && sansiPanelState && sansiPanelState.remainingOptions) {
      const btnsContainer = panel.querySelector('div');
      if (btnsContainer) {
        btnsContainer.innerHTML = '';
        sansiPanelState.remainingOptions.forEach(opt => {
          const btn = document.createElement('button');
          btn.className = 'sansi-option-btn jail-btn';
          btn.textContent = opt;
          btn.style.cssText = 'white-space:nowrap;font-size:14px;padding:6px 10px;opacity:0.5;';
          btn.disabled = true;
          btnsContainer.appendChild(btn);
        });
      }
    }
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

let selectingPropertyClosed = false;
let selectingPropertyEffect = false;
let selectingDayunPlace = false;
let guoneiLvyouSelecting = false;
let selectingWhiteBorderProperty = false;

function checkNoValidTarget() {
  const isSelectingTarget = selectingHezongTarget || sansiSelectingTarget || selectingSwapTarget || selectingRouletteTarget || selectingStartTarget || selectingIslandSwapTarget || selectingJidiTarget || selectingGaichaoTarget || selectingBaijinTarget || selectingNongminTarget || selectingQiyuTarget || selectingGuashaTarget || selectingJiaoyiTarget || selectingZemuerqiTarget || qiutuSelectingPlayers || selectingQiangjieTarget || selectingPinqianTarget || selectingTexasPlayer || selectingLongjuanfengTarget || selectingTingyeTarget || selectingBingdongTarget || selectingHeikeTarget || selectingJinghuaTarget || selectingShuimianTarget || selectingLunciTarget || qiyuAnmianyaoSelecting || qiyuFengdiSelecting || qiyuBaguanSelecting || qiyuBafangQianniuSelecting || qiyuZaizangSelecting || qiyuNilaiWangwangSelecting || qiyuMeirenjiSelecting || qiyuGuhuoSelecting || qiyuGanjinJuejueSelecting || qiyuHunanganshiSelecting || qiyuLianyinSelectingTarget || qiyuBomingSelecting || qiyuJinzuSelecting || qiyuLiufangSelecting || qiyuJiebanWanleSelecting || qiyuTuoleiSelecting || qiyuFuwufeiSelecting || qiyuTudijianbingSelectingTarget || qiyuXiaolicangdaoSelectingTarget || qiyuXiaduSelectingTarget || qiyuJietouDouruSelectingTarget || qiyuAnduchengcangSelectingTarget || qiyuQiankundanayiSelectingTarget || window.selectingXitieshiTarget || window.selectingLijianTarget || daoyingSelectingTarget || selectingJiandieTarget || window.hezuorenwuSelectingTarget || window.meihuoSelectingTarget || selectingChuansongPlayerTarget || selectingFengdiCardTarget || selectingYingmoTarget;
  if (!isSelectingTarget) return;
  const validTargets = players.filter(p => {
    if (p.bankrupt || (p.sheltered && !selectingLongjuanfengTarget && !selectingBingdongTarget && !selectingJinghuaTarget && !qiyuBaguanSelecting && !sansiSelectingTarget && !selectingShuimianTarget && !selectingYingmoTarget)) return false;
    if (!(selectingHezongTarget || selectingRouletteTarget || selectingJidiTarget || qiutuSelectingPlayers || selectingLongjuanfengTarget || selectingTingyeTarget || selectingBingdongTarget || selectingHeikeTarget || selectingJinghuaTarget || selectingShuimianTarget || qiyuAnmianyaoSelecting || qiyuFengdiSelecting || qiyuBaguanSelecting || qiyuZaizangSelecting || qiyuNilaiWangwangSelecting || qiyuBafangQianniuSelecting || qiyuBomingSelecting || qiyuJinzuSelecting || qiyuHunanganshiSelecting || qiyuJietouDouruSelectingTarget || daoyingSelectingTarget || selectingChuansongPlayerTarget || selectingFengdiCardTarget || selectingYingmoTarget || p.id !== myId)) return false;

    if (qiyuNilaiWangwangSelecting && !board.some(s => s.isProperty && s.owner === p.id)) return false;
    if (qiyuNilaiWangwangSelecting && qiyuNilaiWangwangFirstTarget && p.id === qiyuNilaiWangwangFirstTarget) return false;
    if (qiyuMeirenjiSelecting && qiyuMeirenjiFirstTarget && p.id === qiyuMeirenjiFirstTarget) return false;
    if (qiyuMeirenjiSelecting && p.id === myId) return false;
    if (qiyuFengdiSelecting && p.id === myId) return false;
    if (selectingChuansongPlayerTarget && !chuansongCanSelectSelf && p.id === myId) return false;
    if (selectingFengdiCardTarget && !fengdiCardCanSelectSelf && p.id === myId) return false;
    if (qiyuGuhuoSelecting && p.id === myId) return false;
    if (qiyuGanjinJuejueSelecting && p.id === myId) return false;
    if (qiyuLianyinSelectingTarget && p.id === myId) return false;
    if (qiyuBomingSelecting && p.id === myId) return false;
    if (qiyuJinzuSelecting && p.id === myId) return false;
    if (qiyuBafangQianniuSelecting && (p.id === myId || !board.some(s => s.isProperty && s.owner === p.id && s.houseLevel > 0))) return false;
    if (selectingRouletteTarget && rouletteExcludedIds.includes(p.id)) return false;
    if (selectingStartTarget && !startTargetIds.includes(p.id)) return false;
    if (selectingIslandSwapTarget && !islandSwapBidsData.find(b => b.playerId === p.id)) return false;
    if (selectingJidiTarget && (p.id === myId || !jidiAliveIds.includes(p.id))) return false;
    if (selectingGaichaoTarget && p.id === myId) return false;
    if (selectingBaijinTarget && p.id === myId) return false;
    if (selectingNongminTarget && p.id === myId) return false;
    if (selectingNongminTarget && !board.some(s => s.isProperty && s.owner === p.id)) return false;
    if (selectingQiyuTarget && p.id === myId) return false;
    if (selectingQiangjieTarget && p.id === myId) return false;
    if (selectingHezongTarget && p.id === myId) return false;
    if (selectingLongjuanfengTarget && !longjuanfengCanSelectSelf && p.id === myId) return false;
    if (selectingTingyeTarget && !tingyeCanSelectSelf && p.id === myId) return false;
    if (selectingBingdongTarget && !bingdongCanSelectSelf && p.id === myId) return false;
    if (selectingBingdongTarget && p.sheltered && p.id !== myId) return false;
    if (selectingShuimianTarget && !shuimianCanSelf && p.id === myId) return false;
    if (selectingHeikeTarget && (p.id === myId || !p.frozen || p.frozen <= 0)) return false;
    if (qiyuTudijianbingSelectingTarget && (p.id === myId || !board.some(s => s.isProperty && s.owner === p.id))) return false;
    if (qiyuXiaolicangdaoSelectingTarget && p.id === myId) return false;
    if (qiyuXiaduSelectingTarget && (p.id === myId || !p.petImage)) return false;
    if (selectingZemuerqiTarget && (p.id === myId || !p.petImage)) return false;
    if (selectingGuashaTarget && (p.id === myId || p.money <= 50)) return false;
    if (selectingJiaoyiTarget && (p.id === myId || !board.some(s => s.isProperty && s.owner === p.id))) return false;
    if (qiyuJietouDouruSelectingTarget && p.id === myId) return false;
    if (qiyuAnduchengcangSelectingTarget && (p.id === myId || !window.qiyuAnduchengcangTargets?.some(t => t.id === p.id))) return false;
    if (qiyuQiankundanayiSelectingTarget && p.id === myId) return false;
    if (window.hezuorenwuSelectingTarget && (p.id === myId || !window.hezuorenwuTargets?.some(t => t.id === p.id))) return false;
    if (window.meihuoSelectingTarget && (p.id === myId || !window.meihuoTargets?.some(t => t.id === p.id))) return false;
    if (daoyingSelectingTarget && p.id === myId) return false;
    if (selectingLunciTarget && p.id === myId) return false;
    if (selectingJiandieTarget && (p.id === myId || p.sheltered)) return false;
    if (selectingJiandieTarget && jiandieSelectedFirst && p.id === jiandieSelectedFirst) return false;
    return true;
  });
  if (validTargets.length === 0) {
    selectingHezongTarget = false;
    sansiSelectingTarget = false;
    selectingSwapTarget = false;
    selectingRouletteTarget = false;
    selectingStartTarget = false;
    selectingIslandSwapTarget = false;
    selectingJidiTarget = false;
    selectingGaichaoTarget = false;
    selectingBaijinTarget = false;
    selectingNongminTarget = false;
    selectingQiyuTarget = false;
    selectingGuashaTarget = false;
    selectingJiaoyiTarget = false;
    selectingZemuerqiTarget = false;
    jiaoyiSelectingProp = false;
    selectingQiangjieTarget = false;
    selectingBingdongTarget = false;
    selectingShuimianTarget = false;
    qiutuSelectingPlayers = false;
    qiyuTargetId = null;
    startTargetIds = [];
    rouletteExcludedIds = [];
    islandSwapBidsData = [];
    jidiAliveIds = [];
    qiyuAnmianyaoSelecting = false;
    qiyuFengdiSelecting = false;
    selectingChuansongPlayerTarget = false;
    selectingFengdiCardTarget = false;
    selectingTingyeTarget = false;
    selectingYingmoTarget = false;
    qiyuBafangQianniuSelecting = false;
    qiyuZaizangSelecting = false;
    qiyuNilaiWangwangSelecting = false;
    qiyuNilaiWangwangCount = 0;
    qiyuNilaiWangwangFirstTarget = null;
    qiyuMeirenjiSelecting = false;
    qiyuMeirenjiFirstTarget = null;
    qiyuGuhuoSelecting = false;
    qiyuGanjinJuejueSelecting = false;
    qiyuHunanganshiSelecting = false;
    zangkuanSelectingTarget = false;
    fengkongSelectingTarget = false;
    qiyuLianyinSelectingProp = false;
    qiyuLianyinSelectingTarget = false;
    qiyuLianyinPropId = null;
    qiyuYinhuoDefuSelecting = false;
    qiyuBomingSelecting = false;
    qiyuJinzuSelecting = false;
    qiyuLiufangSelecting = false;
    qiyuJiebanWanleSelecting = false;
    qiyuTuoleiSelecting = false;
    qiyuFuwufeiSelecting = false;
    qiyuTudijianbingSelectingTarget = false;
    qiyuXiaolicangdaoSelectingProp = false;
    qiyuXiaolicangdaoSelectingTarget = false;
    qiyuXiaduSelectingTarget = false;
    qiyuJietouDouruSelectingTarget = false;
    qiyuAnduchengcangSelectingTarget = false;
    qiyuAnduchengcangSelectingProp = false;
    qiyuQiankundanayiSelectingTarget = false;
    daoyingSelectingTarget = false;
    selectingLunciTarget = false;
    selectingJiandieTarget = false;
    jiandieSelectedFirst = null;
    window.hezuorenwuSelectingTarget = false;
    window.meihuoSelectingTarget = false;
    sansiPanelState = null;
    const sansiPanel = document.getElementById('sansiPanel');
    if (sansiPanel) sansiPanel.remove();
    const sansiPanel2 = document.querySelector('.sansi-panel');
    if (sansiPanel2) sansiPanel2.remove();
    const jidiOverlay = document.getElementById('jidiOverlay');
    if (jidiOverlay) jidiOverlay.remove();
    const petShopPanel = document.getElementById('petShopPanel');
    if (petShopPanel) petShopPanel.remove();
    showBoardArea();
    renderBoardOnly();
    refreshPlayerCards();
    $('areaE').innerHTML = '没有合适的目标';
    document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    $('endTurnBtn').onclick = () => doEndTurn();
  }
}

socket.on('noValidTarget', () => {
  sansiSelectingTarget = false;
  selectingHezongTarget = false;
  selectingSwapTarget = false;
  selectingRouletteTarget = false;
  selectingBingdongTarget = false;
  selectingTingyeTarget = false;
  qiyuTuoleiSelecting = false;
  qiyuFuwufeiSelecting = false;
  rouletteExcludedIds = [];
  sansiPanelState = null;
  // 关闭所有面板
  const sansiPanel = document.getElementById('sansiPanel');
  if (sansiPanel) sansiPanel.remove();
  document.querySelectorAll('.sansi-panel, .sansi-overlay').forEach(el => el.remove());
  const exilePanel = document.getElementById('exilePanel');
  if (exilePanel) exilePanel.remove();
  const wuyuePanel = document.getElementById('wuyueReformPanel');
  if (wuyuePanel) wuyuePanel.remove();
  const airportPanel = document.getElementById('airportReformPanel');
  if (airportPanel) airportPanel.remove();
  const mazePanel = document.getElementById('mazePanel');
  if (mazePanel) mazePanel.remove();
  const texasPanel = document.querySelector('.texas-panel');
  if (texasPanel) texasPanel.remove();
  clearTips();
  showBoardArea();
  renderBoardOnly();
  $('areaE').innerHTML = '没有合适的目标';
  fitAreaEText();
  const cur = players[currentPlayerIdx];
  if (cur?.id === myId && !cur?.bankrupt) {
    document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    $('endTurnBtn').onclick = () => doEndTurn();
  } else {
    document.getElementById('areaF').innerHTML = '';
  }
});

socket.on('sansiSelectPropertyClosed', ({ playerId, option }) => {
  if (playerId === myId) {
    selectingPropertyClosed = true;
    const panel = document.getElementById('sansiPanel');
    if (panel) {
      panel.innerHTML = `<div style="color:#000;font-size:20px;background:rgba(255,255,255,0.5);padding:10px 20px;border-radius:8px;">请选择一块有地主的地产停业</div>`;
    }
    $('areaE').innerHTML = '请选择一块有地主的地产停业';
    fitAreaEText();
    renderBoardOnly();
  }
});

socket.on('sansiSelectPropertyEffect', ({ playerId, option }) => {
  if (playerId === myId) {
    selectingPropertyEffect = true;
    const panel = document.getElementById('sansiPanel');
    if (panel) {
      panel.innerHTML = `<div style="color:#000;font-size:20px;background:rgba(255,255,255,0.5);padding:10px 20px;border-radius:8px;">请选择你的一块地产</div>`;
    }
    $('areaE').innerHTML = '请选择你的一块地产';
    fitAreaEText();
    renderBoardOnly();
  }
});

socket.on('extraTurnHighlight', ({ playerId }) => {
  extraTurnPlayerId = playerId;
  refreshPlayerCards();
});

socket.on('sansiSelected', ({ playerId, playerName, playerColor, option, remaining, targetMsg }) => {
  flyTargetHighlight = null;
  const prevMsg = targetMsg ? `${targetMsg}` : '';
  $('areaE').innerHTML = `${prevMsg}${coloredName(playerName, playerColor)}选择了${option}，请选目标`;
  fitAreaEText();

  if (sansiPanelState) {
    sansiPanelState.selectedOption = option;
    sansiPanelState.remainingOptions = remaining;
    sansiPanelState.phase = 'selectTarget';
    if (selectingPropertyEffect || selectingPropertyClosed) {
      const panel = document.getElementById('sansiPanel');
      if (panel) {
        const msg = selectingPropertyClosed ? '请选择一块有地主的地产停业' : '请选择你的一块地产';
        panel.innerHTML = `<div style="color:#000;font-size:20px;background:rgba(255,255,255,0.5);padding:10px 20px;border-radius:8px;">${msg}</div>`;
      }
    } else {
      const panel = document.getElementById('sansiPanel');
      if (panel) {
        panel.style.display = 'flex';
      } else {
        reattachSansiPanel();
      }
    }
  }

  if (playerId === myId) {
    sansiSelectingTarget = true;
    refreshPlayerCards();
    checkNoValidTarget();
  }
});

socket.on('sansiTargetChosen', ({ playerId, targetId, targetName, targetColor, remaining, hiddenMsg }) => {
  sansiSelectingTarget = false;
  $('areaE').innerHTML = `${hiddenMsg || ''}${coloredName(targetName, targetColor)}，请2选1`;
  fitAreaEText();

  if (sansiPanelState) {
    sansiPanelState.phase = 'otherSelect';
    sansiPanelState.targetId = targetId;
    sansiPanelState.targetName = targetName;
    sansiPanelState.targetColor = targetColor;
    sansiPanelState.remainingOptions = remaining;
  }

  const panel = document.getElementById('sansiPanel');
  const isTarget = targetId === myId;

  if (panel) {
    const targetPlayer = players.find(p => p.id === targetId);
    const targetHasDiamond = targetPlayer && targetPlayer.hasDiamond;
    const targetHasKey = targetPlayer && targetPlayer.cards && targetPlayer.cards.some(c => c.id === 13);
    const targetHasPet = targetPlayer && !!targetPlayer.petImage;
    const targetHasProperty = targetPlayer && board.some(s => s.isProperty && s.owner === targetId);
    let btnsHtml = '';
    let allDisabled = true;
    remaining.forEach(opt => {
      let optDisabled = !isTarget;
      if (isTarget) {
        if (opt === '将你的钻石转换为随机2张卡' && !targetHasDiamond) optDisabled = true;
      }
      if (!optDisabled) allDisabled = false;
      btnsHtml += `<button class="sansi-option-btn jail-btn" data-option="${opt}" ${optDisabled ? 'disabled style="opacity:0.5"' : ''}>${opt}</button>`;
    });

    if (allDisabled && isTarget) {
      socket.emit('sansiOtherSkip');
      return;
    }

    panel.style.display = 'flex';
    panel.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 12px; pointer-events: auto;">
        ${btnsHtml}
      </div>
    `;

    if (isTarget) {
      document.querySelectorAll('.sansi-option-btn:not([disabled])').forEach(btn => {
        btn.onclick = () => {
          const option = btn.dataset.option;
          socket.emit('sansiOtherSelect', { option });
        };
      });
    }
  }

  refreshPlayerCards();
});

socket.on('sansiComplete', ({ playerId, playerName, playerColor, option, targetMsg }) => {
  flyTargetHighlight = null;
  sansiPanelState = null;
  const panel = document.getElementById('sansiPanel');
  if (panel) panel.remove();
  const prevMsg = targetMsg ? `${targetMsg}` : '';
  $('areaE').innerHTML = `${prevMsg}${coloredName(playerName, playerColor)}选择了${option}`;
  fitAreaEText();

  const cur = players[currentPlayerIdx];
  const isMyTurn = cur?.id === myId && !cur?.bankrupt;
  if (isMyTurn) {
    document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    const endTurnBtn = document.getElementById('endTurnBtn');
    if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
  }
  updateGAreaDiceImage(currentDiceValue, isMyTurn);
});

socket.on('pinqianSelect', () => {
  $('areaE').textContent = '请选择1名其他角色，拼钱胜+10';
  selectingPinqianTarget = true;
  refreshPlayerCards();
});

socket.on('pinqianStart', ({ playerName, playerColor, targetName, targetColor, isCurrent, qiongqi, qinglong, qinglongPropertyName }) => {
  isJailMap = true;
  
  const boardEl = $('board');
  if (!boardEl) return;
  
  const me = players.find(p => p.id === myId);
  const maxMoney = me ? (me.money + (me.tempMoney || 0)) : 0;
  
  const panel = document.createElement('div');
  panel.id = 'pinqianPanel';
  panel.style.position = 'absolute';
  panel.style.top = '0';
  panel.style.left = '0';
  panel.style.right = '0';
  panel.style.bottom = '0';
  panel.style.zIndex = '100';
  panel.style.pointerEvents = 'auto';
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.alignItems = 'center';
  panel.style.justifyContent = 'center';
  panel.style.background = '#1a2a4a';
  panel.style.gap = '6px';
  panel.style.padding = '8px';
  panel.style.overflow = 'hidden';
  
  const qImg = qiongqi ? '/drawable/chongwu/10.png' : qinglong ? '/drawable/chongwu/12.png' : '/drawable/pinqian.png';
  const qDesc = qiongqi ? `${coloredName(playerName, playerColor)}与地主${coloredName(targetName, targetColor)}拼钱，若胜掠夺10%现金` : qinglong ? `${coloredName(playerName, playerColor)}与地主${coloredName(targetName, targetColor)}拼钱，胜获得${qinglongPropertyName || '地产'}` : '';
  panel.innerHTML = `
    <img src="${qImg}" style="width:clamp(80px,30vw,200px);height:auto;border-radius:8px;">
    ${qDesc ? `<div style="color:#fff;font-size:clamp(12px,3vw,18px);text-align:center;">${qDesc}</div>` : ''}
    <div style="display:flex;align-items:center;gap:6px;">
      <input type="text" id="pinqianNumber" value="0" readonly style="width:clamp(60px,15vw,100px);text-align:center;font-size:clamp(16px,4vw,28px);background:#fff;color:#000;border:1px solid #666;padding:4px;border-radius:4px;font-weight:bold;">
      <button id="pinqianClearBtn" class="pinqian-calc-btn" disabled style="color:transparent;">清零</button>
      <button id="pinqianConfirmBtn" class="pinqian-calc-btn" disabled style="color:transparent;">确定</button>
    </div>
    <div style="display:flex;gap:4px;">
      <button class="pinqian-calc-btn pinqian-num" data-val="1">1</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="2">2</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="3">3</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="4">4</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="5">5</button>
    </div>
    <div style="display:flex;gap:4px;">
      <button class="pinqian-calc-btn pinqian-num" data-val="6">6</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="7">7</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="8">8</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="9">9</button>
      <button class="pinqian-calc-btn pinqian-num" data-val="0">0</button>
    </div>
  `;
  
  const style = document.createElement('style');
  style.textContent = `.pinqian-calc-btn { min-width:clamp(30px,8vw,50px);height:clamp(30px,8vw,50px);background:#333;color:#fff;border:none;border-radius:8px;font-size:clamp(14px,3.5vw,20px);cursor:pointer;padding:0 8px;pointer-events:auto; } .pinqian-calc-btn:hover { background:#555; } .pinqian-calc-btn:disabled { background:#333 !important; color:transparent !important; opacity:1 !important; }`;
  panel.appendChild(style);
  
  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);
  
  $('areaE').innerHTML = `${coloredName(isCurrent ? playerName : targetName, isCurrent ? playerColor : targetColor)}，请拼钱（视为支付）`;
  
  let currentValue = '0';
  const updateDisplay = () => {
    const numEl = $('pinqianNumber');
    const clearBtn = $('pinqianClearBtn');
    const confirmBtn = $('pinqianConfirmBtn');
    if (numEl) numEl.value = currentValue;
    if (clearBtn && confirmBtn) {
      if (currentValue === '0') {
        clearBtn.disabled = true;
        clearBtn.style.color = 'transparent';
        confirmBtn.disabled = true;
        confirmBtn.style.color = 'transparent';
      } else {
        clearBtn.disabled = false;
        clearBtn.style.color = '#fff';
        confirmBtn.disabled = false;
        confirmBtn.style.color = '#fff';
      }
    }
  };
  
  document.querySelectorAll('.pinqian-num').forEach(btn => {
    btn.onclick = () => {
      const val = btn.dataset.val;
      let newValue;
      if (currentValue === '0') {
        newValue = val;
      } else {
        newValue = currentValue + val;
      }
      if (parseInt(newValue) > 999) {
        return;
      }
      currentValue = newValue;
      updateDisplay();
    };
  });
  
  const clearBtn = $('pinqianClearBtn');
  if (clearBtn) {
    clearBtn.onclick = () => {
      currentValue = '0';
      updateDisplay();
    };
  }
  
  const confirmBtn = $('pinqianConfirmBtn');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      const value = parseInt(currentValue) || 0;
      socket.emit('pinqianConfirmWithValue', value);
    };
  }
});

socket.on('pinqianConfirmed', () => {
  const pnl = $('pinqianPanel');
  if (pnl) pnl.remove();
  document.getElementById('areaF').innerHTML = '';
  $('areaE').textContent = '等待对方确认...';
});

socket.on('pinqianUpdate', ({ number }) => {
  const numEl = $('pinqianNumber');
  if (numEl) numEl.textContent = number;
  
  const confirmBtn = $('pinqianConfirmBtn');
  if (confirmBtn) {
    confirmBtn.disabled = number <= 0;
    confirmBtn.style.color = number <= 0 ? 'transparent' : '#fff';
  }
});

socket.on('pinqianEnd', ({ message }) => {
  isJailMap = false;
  const panel = $('pinqianPanel');
  if (panel) panel.remove();
  document.getElementById('areaF').innerHTML = '';
  $('areaE').innerHTML = message;
});

socket.on('gaokaoStart', ({ playerName, playerColor }) => {
  isJailMap = true;
  const boardEl = $('board');
  if (!boardEl) return;
  const me = players.find(p => p.id === myId);
  const maxMoney = me ? (me.money + (me.tempMoney || 0)) : 0;
  const panel = document.createElement('div');
  panel.id = 'gaokaoPanel';
  panel.style.position = 'absolute';
  panel.style.top = '0';
  panel.style.left = '0';
  panel.style.right = '0';
  panel.style.bottom = '0';
  panel.style.zIndex = '100';
  panel.style.pointerEvents = 'auto';
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.alignItems = 'center';
  panel.style.justifyContent = 'center';
  panel.style.background = '#1a2a4a';
  panel.style.gap = '10px';
  panel.innerHTML = `
    <img src="/drawable/jiyu/gaokao.jpg" style="width:150px;height:auto;border-radius:8px;">
    <div style="display:flex;align-items:center;gap:10px;">
      <input type="text" id="gaokaoNumber" value="0" readonly style="width:100px;text-align:center;font-size:28px;background:#fff;color:#000;border:1px solid #666;padding:8px;border-radius:4px;font-weight:bold;">
      <button id="gaokaoClearBtn" class="gaokao-calc-btn" disabled style="color:transparent;">清零</button>
      <button id="gaokaoConfirmBtn" class="gaokao-calc-btn" disabled style="color:transparent;">确定</button>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="gaokao-calc-btn gaokao-num" data-val="0">0</button>
      <button class="gaokao-calc-btn gaokao-num" data-val="1">1</button>
      <button class="gaokao-calc-btn gaokao-num" data-val="2">2</button>
      <button class="gaokao-calc-btn gaokao-num" data-val="3">3</button>
      <button class="gaokao-calc-btn gaokao-num" data-val="4">4</button>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="gaokao-calc-btn gaokao-num" data-val="5">5</button>
      <button class="gaokao-calc-btn gaokao-num" data-val="6">6</button>
      <button class="gaokao-calc-btn gaokao-num" data-val="7">7</button>
      <button class="gaokao-calc-btn gaokao-num" data-val="8">8</button>
      <button class="gaokao-calc-btn gaokao-num" data-val="9">9</button>
    </div>
  `;
  const style = document.createElement('style');
  style.textContent = `.gaokao-calc-btn { min-width:50px;height:50px;background:#333;color:#fff;border:none;border-radius:8px;font-size:20px;cursor:pointer;padding:0 12px;pointer-events:auto; } .gaokao-calc-btn:hover { background:#555; } .gaokao-calc-btn:disabled { background:#333 !important; color:transparent !important; opacity:1 !important; }`;
  panel.appendChild(style);
  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);
  $('areaE').innerHTML = '高考：群体竞价拼钱，按名次依次获得50-20-0-负10-负20-负50';
  
  let currentValue = '0';
  const updateDisplay = () => {
    const numEl = $('gaokaoNumber');
    const clearBtn = $('gaokaoClearBtn');
    const confirmBtn = $('gaokaoConfirmBtn');
    if (numEl) numEl.value = currentValue;
    if (clearBtn && confirmBtn) {
      if (currentValue === '0') {
        clearBtn.disabled = true;
        clearBtn.style.color = 'transparent';
        confirmBtn.disabled = true;
        confirmBtn.style.color = 'transparent';
      } else {
        clearBtn.disabled = false;
        clearBtn.style.color = '#fff';
        confirmBtn.disabled = false;
        confirmBtn.style.color = '#fff';
      }
    }
  };
  
  document.querySelectorAll('.gaokao-num').forEach(btn => {
    btn.onclick = () => {
      const val = btn.dataset.val;
      let newValue;
      if (currentValue === '0') {
        newValue = val;
      } else {
        newValue = currentValue + val;
      }
      if (parseInt(newValue) > 999) {
        return;
      }
      currentValue = newValue;
      updateDisplay();
    };
  });
  
  const clearBtn = $('gaokaoClearBtn');
  if (clearBtn) {
    clearBtn.onclick = () => {
      currentValue = '0';
      updateDisplay();
    };
  }
  
  const confirmBtn = $('gaokaoConfirmBtn');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      const value = parseInt(currentValue) || 0;
      socket.emit('gaokaoConfirmWithValue', value);
    };
  }
});

socket.on('gaokaoUpdate', ({ number }) => {
  const numEl = $('gaokaoNumber');
  if (numEl) numEl.value = number;
  const confirmBtn = $('gaokaoConfirmBtn');
  if (confirmBtn) {
    confirmBtn.disabled = number <= 0;
    confirmBtn.style.color = number <= 0 ? 'transparent' : '#fff';
  }
});

socket.on('gaokaoConfirmed', () => {
  const pnl = $('gaokaoPanel');
  if (pnl) pnl.remove();
  document.getElementById('areaF').innerHTML = '';
  $('areaE').textContent = '等待其他人确认...';
});

socket.on('gaokaoEnd', ({ message }) => {
  isJailMap = false;
  const panel = $('gaokaoPanel');
  if (panel) panel.remove();
  document.getElementById('areaF').innerHTML = '';
  $('areaE').innerHTML = message;
});

socket.on('yexinjiaChoice', ({ playerId }) => {
  if (socket.id !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '<button id="yexinPlus10" class="jail-btn">+10</button><button id="yexinFight60" class="jail-btn">争夺60</button>';
  $('yexinPlus10').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('yexinjiaSelect', { choice: 'plus10' });
  };
  $('yexinFight60').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('yexinjiaSelect', { choice: 'fight60' });
  };
});

socket.on('yexinjiaEnd', () => {
  document.getElementById('areaF').innerHTML = '';
});

socket.on('cishanjiaChoice', () => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '<button id="cishanBtn" class="jail-btn">慈善</button><button id="cishanEndBtn" class="jail-btn">结束</button>';
  $('cishanBtn').onclick = () => {
    areaF.innerHTML = '';
    selectingQiyuTarget = true;
    qiyuTargetId = 25;
    refreshPlayerCards();
    checkNoValidTarget();
  };
  $('cishanEndBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
});

socket.on('jiubaChoice', ({ playerId }) => {
  if (socket.id !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '<button id="jiubaBarBtn" class="jail-btn">去酒吧</button><button id="jiubaHomeBtn" class="jail-btn">呆在家</button>';
  $('jiubaBarBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('jiubaSelect', { choice: 'bar' });
  };
  $('jiubaHomeBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('jiubaSelect', { choice: 'home' });
  };
});

socket.on('jiubaEnd', () => {
  document.getElementById('areaF').innerHTML = '';
});

socket.on('yinyueDiceChoice', () => {
  showDiceSelectInF(1, 6, (i) => {
    socket.emit('yinyueDiceSelect', { dice: i });
  });
});

socket.on('yinyueEnd', () => {
  document.getElementById('areaF').innerHTML = '';
});

socket.on('gongtongChoice', ({ playerId, propCount, cheapestName }) => {
  if (socket.id !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = `<button id="gongtongMinusBtn" class="jail-btn">${cheapestName}-1</button><button id="gongtongKeepBtn" class="jail-btn">保持（${propCount}）</button>`;
  $('gongtongMinusBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('gongtongSelect', { choice: 'minus1' });
  };
  $('gongtongKeepBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('gongtongSelect', { choice: 'keep' });
  };
});

socket.on('gongtongEnd', () => {
  document.getElementById('areaF').innerHTML = '';
});

socket.on('mammothFrozenStay', () => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
  $('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
  const areaG = $('areaG');
  if (areaG) {
    areaG.innerHTML = '';
    areaG.style.cursor = 'default';
    areaG.onclick = null;
  }
});

socket.on('mammothFrozenRelease', () => {
  showThinkingOnce = false;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
  const cur = players.find(p => p.id === myId);
  const isMyTurn = cur && players[currentPlayerIdx] && cur.id === players[currentPlayerIdx].id;
  updateGAreaDiceImage(0, isMyTurn);
});

socket.on('shihuaContinue', () => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
  $('endTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('endTurn');
  };
  const areaG = $('areaG');
  if (areaG) {
    areaG.innerHTML = '';
    areaG.style.cursor = 'default';
    areaG.onclick = null;
  }
});

socket.on('shihuaEnd', () => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
  const cur = players.find(p => p.id === myId);
  const isMyTurn = cur && players[currentPlayerIdx] && cur.id === players[currentPlayerIdx].id;
  updateGAreaDiceImage(0, isMyTurn);
});

socket.on('yihuaSelectSource', () => {
  board.forEach(space => {
    if (space.isProperty && space.owner && space.owner !== myId && space.houseLevel > 0) {
      const el = document.querySelector(`.space[data-id="${space.id}"]`);
      if (el) {
        el.style.boxShadow = '0 0 8px #fff, 0 0 16px #fff';
        el.style.cursor = 'pointer';
        el.onclick = () => {
          clearYihuaHighlights();
          socket.emit('yihuaSelectSource', { propertyId: space.id });
        };
      }
    }
  });
});

socket.on('yihuaSelectTarget', ({ sourceName }) => {
  board.forEach(space => {
    if (space.isProperty && space.owner === myId) {
      const el = document.querySelector(`.space[data-id="${space.id}"]`);
      if (el) {
        el.style.boxShadow = '0 0 8px #fff, 0 0 16px #fff';
        el.style.cursor = 'pointer';
        el.onclick = () => {
          clearYihuaHighlights();
          socket.emit('yihuaSelectTarget', { propertyId: space.id });
        };
      }
    }
  });
});

socket.on('yihuaEnd', () => {
  clearYihuaHighlights();
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
});

function clearYihuaHighlights() {
  document.querySelectorAll('.space').forEach(el => {
    el.style.boxShadow = '';
    el.style.cursor = '';
    el.onclick = null;
  });
}

socket.on('hebaoSelectRow', () => {
  const boardEl = $('board');
  if (!boardEl) return;
  for (let row = 1; row <= 6; row++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'hebao-row-wrapper';
    wrapper.dataset.row = row;
    wrapper.style.cssText = `grid-row:${row};grid-column:1/7;border:3px solid #fff;cursor:pointer;z-index:10;display:flex;align-items:center;justify-content:center;`;
    wrapper.onclick = () => {
      document.querySelectorAll('.hebao-row-wrapper').forEach(w => w.remove());
      socket.emit('hebaoSelectRow', { row: parseInt(wrapper.dataset.row) });
    };
    boardEl.appendChild(wrapper);
  }
});

socket.on('hebaoEnd', () => {
  document.querySelectorAll('.hebao-row-wrapper').forEach(w => w.remove());
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
});

socket.on('huanranSelectRow', () => {
  const boardEl = $('board');
  if (!boardEl) return;
  for (let row = 1; row <= 6; row++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'huanran-row-wrapper';
    wrapper.dataset.row = row;
    wrapper.style.cssText = `grid-row:${row};grid-column:1/7;border:3px solid #fff;cursor:pointer;z-index:10;display:flex;align-items:center;justify-content:center;`;
    wrapper.onclick = () => {
      document.querySelectorAll('.huanran-row-wrapper').forEach(w => w.remove());
      socket.emit('huanranSelectRow', { row: parseInt(wrapper.dataset.row) });
    };
    boardEl.appendChild(wrapper);
  }
});

socket.on('huanranEnd', () => {
  document.querySelectorAll('.huanran-row-wrapper').forEach(w => w.remove());
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
});

socket.on('shengdongDeclareBoard', ({ targetId }) => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
  showShengdongPropertySelector(targetId, 'declare');
});

socket.on('shengdongAttackBoard', ({ targetId }) => {
  showShengdongPropertySelector(targetId, 'attack');
});

socket.on('shengdongProtectBoard', ({ targetId }) => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
  showShengdongPropertySelector(targetId, 'protect');
});

function showShengdongPropertySelector(targetId, type) {
  const boardEl = $('board');
  if (!boardEl) return;
  document.querySelectorAll('.shengdong-prop-wrapper').forEach(w => w.remove());
  const targetProps = window.boardData ? window.boardData.filter(s => s.isProperty && s.owner === targetId) : [];
  targetProps.forEach(prop => {
    const wrapper = document.createElement('div');
    wrapper.className = 'shengdong-prop-wrapper';
    wrapper.dataset.propId = prop.id;
    wrapper.style.cssText = `position:absolute;left:0;top:0;right:0;bottom:0;border:3px solid #fff;cursor:pointer;z-index:10;pointer-events:auto;`;
    wrapper.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll('.shengdong-prop-wrapper').forEach(w => w.remove());
      if (type === 'declare') {
        socket.emit('shengdongDeclare', { propId: prop.id });
      } else if (type === 'attack') {
        socket.emit('shengdongAttack', { propId: prop.id });
      } else if (type === 'protect') {
        socket.emit('shengdongProtect', { propId: prop.id });
      }
    };
    const cell = boardEl.querySelector(`[data-id="${prop.id}"]`);
    if (cell) cell.appendChild(wrapper);
  });
}

socket.on('shengdongEnd', () => {
  document.querySelectorAll('.shengdong-prop-wrapper').forEach(w => w.remove());
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
});

socket.on('saidaoChoice', ({ playerId }) => {
  if (myId !== playerId) return;
  showDiceSelectInF(1, 5, (i) => {
    socket.emit('saidaoSelect', { number: i });
  });
});

socket.on('saidaoSelected', () => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
});

socket.on('lihunPanel', ({ commanderId, commanderName, commanderColor, targetId, targetName, targetColor, properties }) => {
  const boardEl = $('board');
  if (!boardEl) return;
  const existing = document.getElementById('lihunPanel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'lihunPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;display:flex;flex-direction:column;background-image:url(/drawable/bj3.png);background-size:cover;background-position:center;padding:8px;box-sizing:border-box;overflow:hidden;';

  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);

  const isTarget = myId === targetId;
  let selectedCard = null;
  window.lihunPropData = properties;

  requestAnimationFrame(() => {
    const panelH = panel.clientHeight;
    const panelW = panel.clientWidth;
    const bottomRowH = 40;
    const dividerH = 3;
    const rowH = (panelH - bottomRowH - dividerH - 16) / 2;
    const cardW = Math.min((panelW - 16) / 7, rowH / 3);

    function makeRow(rowId) {
      const row = document.createElement('div');
      row.id = rowId;
      row.style.cssText = `height:${rowH}px;display:flex;flex-wrap:wrap;gap:2px;padding:2px;align-content:flex-start;overflow-y:auto;`;
      if (isTarget) {
        row.addEventListener('click', e => {
          if (e.target === row && selectedCard) {
            row.appendChild(selectedCard);
            selectedCard.style.borderColor = 'transparent';
            selectedCard = null;
          }
        });
      }
      return row;
    }

    const row1 = makeRow('lihunRow1');
    const divider = document.createElement('div');
    divider.style.cssText = `height:${dividerH}px;background:#fff;margin:2px 0;flex-shrink:0;`;
    const row2 = makeRow('lihunRow2');

    const bottomRow = document.createElement('div');
    bottomRow.id = 'lihunBottomRow';
    bottomRow.style.cssText = `height:${bottomRowH}px;display:flex;justify-content:center;align-items:center;flex-shrink:0;`;

    properties.forEach(prop => {
      const card = document.createElement('div');
      card.className = 'lihun-prop-card';
      card.dataset.propId = prop.id;
      card.dataset.propName = prop.name;
      card.dataset.propRent = prop.rent;
      card.style.cssText = `width:${cardW - 4}px;height:${cardW - 4}px;background:#fff;color:#000;border-radius:4px;padding:2px;text-align:center;font-size:14px;user-select:none;border:2px solid transparent;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;align-items:center;overflow:hidden;`;
      card.innerHTML = `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;">${prop.name}</div><div style="font-size:11px;">${prop.rent}</div>`;
      card.draggable = isTarget;
      if (isTarget) {
        card.addEventListener('dragstart', e => {
          e.dataTransfer.setData('text/plain', card.dataset.propId);
        });
        card.addEventListener('click', e => {
          e.stopPropagation();
          if (selectedCard && selectedCard !== card) {
            selectedCard.style.borderColor = 'transparent';
          }
          if (selectedCard === card) {
            card.style.borderColor = 'transparent';
            selectedCard = null;
          } else {
            card.style.borderColor = '#f1c40f';
            selectedCard = card;
          }
        });
      }
      row1.appendChild(card);
    });

    if (isTarget) {
      row1.addEventListener('dragover', e => { e.preventDefault(); });
      row1.addEventListener('drop', e => {
        e.preventDefault();
        const card = document.querySelector(`.lihun-prop-card[data-prop-id="${e.dataTransfer.getData('text/plain')}"]`);
        if (card) row1.appendChild(card);
      });
      row2.addEventListener('dragover', e => { e.preventDefault(); });
      row2.addEventListener('drop', e => {
        e.preventDefault();
        const card = document.querySelector(`.lihun-prop-card[data-prop-id="${e.dataTransfer.getData('text/plain')}"]`);
        if (card) row2.appendChild(card);
      });

      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = '确定';
      confirmBtn.className = 'jail-btn';
      confirmBtn.style.cssText = 'font-size:16px;padding:8px 24px;';
      confirmBtn.onclick = () => {
        const row1Ids = [...row1.querySelectorAll('.lihun-prop-card')].map(c => parseInt(c.dataset.propId));
        const row2Ids = [...row2.querySelectorAll('.lihun-prop-card')].map(c => parseInt(c.dataset.propId));
        socket.emit('lihunConfirm', { row1PropIds: row1Ids, row2PropIds: row2Ids });
      };
      bottomRow.appendChild(confirmBtn);
    }

    panel.appendChild(row1);
    panel.appendChild(divider);
    panel.appendChild(row2);
    panel.appendChild(bottomRow);
  });
});

socket.on('lihunTargetConfirmed', ({ row1PropIds, row2PropIds }) => {
  const row1 = document.getElementById('lihunRow1');
  const row2 = document.getElementById('lihunRow2');
  if (row1 && row2 && window.lihunPropData) {
    const allCards = [...document.querySelectorAll('.lihun-prop-card')];
    allCards.forEach(c => c.remove());
    const panel = document.getElementById('lihunPanel');
    const panelW = panel ? panel.clientWidth : 400;
    const rowH = row1.clientHeight;
    const cardW = Math.min((panelW - 16) / 7, rowH / 3);
    
    const createCard = (propId) => {
      const prop = window.lihunPropData.find(p => p.id === propId);
      if (!prop) return null;
      const card = document.createElement('div');
      card.className = 'lihun-prop-card';
      card.dataset.propId = prop.id;
      card.style.cssText = `width:${cardW - 4}px;height:${cardW - 4}px;background:#fff;color:#000;border-radius:4px;padding:2px;text-align:center;font-size:14px;user-select:none;border:2px solid transparent;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;align-items:center;overflow:hidden;`;
      card.innerHTML = `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;">${prop.name}</div><div style="font-size:11px;">${prop.rent}</div>`;
      return card;
    };
    
    row1PropIds.forEach(id => {
      const card = createCard(id);
      if (card) row1.appendChild(card);
    });
    row2PropIds.forEach(id => {
      const card = createCard(id);
      if (card) row2.appendChild(card);
    });
  }
  const confirmBtn = document.querySelector('#lihunPanel button');
  if (confirmBtn) confirmBtn.remove();
  document.querySelectorAll('.lihun-prop-card').forEach(c => { c.draggable = false; c.style.cursor = 'default'; });
});

socket.on('lihunChooseRow', ({ row1PropIds, row2PropIds }) => {
  const row1 = document.getElementById('lihunRow1');
  const row2 = document.getElementById('lihunRow2');
  const bottomRow = document.getElementById('lihunBottomRow');
  let selectedRow = null;
  if (row1) {
    row1.style.cursor = 'pointer';
    row1.style.pointerEvents = 'auto';
    row1.onclick = () => {
      if (selectedRow === 1) return;
      selectedRow = 1;
      row1.style.border = '2px solid #fff';
      row2.style.border = 'none';
    };
  }
  if (row2) {
    row2.style.cursor = 'pointer';
    row2.style.pointerEvents = 'auto';
    row2.onclick = () => {
      if (selectedRow === 2) return;
      selectedRow = 2;
      row2.style.border = '2px solid #fff';
      row1.style.border = 'none';
    };
  }
  if (bottomRow) {
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '确定';
    confirmBtn.className = 'jail-btn';
    confirmBtn.style.cssText = 'font-size:16px;padding:8px 24px;';
    confirmBtn.onclick = () => {
      if (selectedRow) {
        socket.emit('lihunSelectRow', { selectedRow });
      }
    };
    bottomRow.appendChild(confirmBtn);
  }
});

socket.on('lihunEnd', () => {
  const panel = document.getElementById('lihunPanel');
  if (panel) panel.remove();
});

let qiutuSelectingPlayers = false;
let qiutuSelectedCount = 0;

socket.on('qiutuSelectPlayers', ({ playerId }) => {
  if (myId !== playerId) return;
  qiutuSelectingPlayers = true;
  qiutuSelectedCount = 0;
  refreshPlayerCards();
});

window.selectQiutuPlayer = function(targetId) {
  if (!qiutuSelectingPlayers) return;
  socket.emit('qiutuSelectPlayer', { playerId: targetId });
  qiutuSelectedCount++;
  if (qiutuSelectedCount >= 2) {
    qiutuSelectingPlayers = false;
    refreshPlayerCards();
  }
};

socket.on('qiutuChoice', ({ playerId }) => {
  if (myId !== playerId) return;
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
  const coopBtn = document.createElement('button');
  coopBtn.textContent = '合作';
  coopBtn.className = 'jail-btn';
  coopBtn.style.cssText = 'margin:5px;padding:8px 16px;font-size:14px;cursor:pointer;';
  coopBtn.onclick = () => {
    socket.emit('qiutuSelect', { choice: 'cooperate' });
  };
  const betrayBtn = document.createElement('button');
  betrayBtn.textContent = '背叛';
  betrayBtn.className = 'jail-btn';
  betrayBtn.style.cssText = 'margin:5px;padding:8px 16px;font-size:14px;cursor:pointer;';
  betrayBtn.onclick = () => {
    socket.emit('qiutuSelect', { choice: 'betray' });
  };
  areaF.appendChild(coopBtn);
  areaF.appendChild(betrayBtn);
});

socket.on('qiutuSelected', () => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '';
});

socket.on('kanuSelectCards', ({ cards }) => {
  const boardEl = $('board');
  if (!boardEl) return;
  const existing = document.getElementById('kanuPanel');
  if (existing) existing.remove();

  let selectedIds = [];

  const panel = document.createElement('div');
  panel.id = 'kanuPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,1);padding:8px;box-sizing:border-box;overflow:hidden;';

  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);

  requestAnimationFrame(() => {
    const panelH = panel.clientHeight;
    const panelW = panel.clientWidth;
    const bottomRowH = 40;
    const gridH = panelH - bottomRowH - 16;
    const cols = Math.ceil(Math.sqrt(cards.length * (panelW / gridH)));
    const cardSize = Math.floor(Math.min((panelW - 16) / cols, gridH / Math.ceil(cards.length / cols)));

    let html = `<div id="kanuGridArea" style="flex:1;display:flex;flex-wrap:wrap;gap:4px;justify-content:center;align-items:center;overflow:hidden;">`;
    cards.forEach(card => {
      html += `<img src="/drawable/kapian/${card.image}.png" data-card-id="${card.id}" data-card-desc="${card.description}" style="width:${cardSize}px;height:${cardSize}px;object-fit:contain;cursor:pointer;border-radius:4px;border:2px solid transparent;transition:border-color 0.2s;" class="kanu-grid-card">`;
    });
    html += '</div>';
    html += '<div id="kanuBottomRow" style="height:40px;min-height:40px;display:flex;align-items:center;gap:8px;width:100%;padding:0 4px;">';
    html += '<div id="kanuDesc" style="flex:1;color:#fff;font-size:14px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>';
    html += '<button id="kanuConfirmBtn" class="jail-btn" style="padding:6px 16px;border-radius:8px;opacity:0.5;" disabled>确定（0/4）</button>';
    html += '</div>';
    panel.innerHTML = html;

    document.querySelectorAll('.kanu-grid-card').forEach(img => {
      img.onclick = () => {
        const cardId = parseInt(img.dataset.cardId);
        if (selectedIds.includes(cardId)) {
          selectedIds = selectedIds.filter(id => id !== cardId);
          img.style.borderColor = 'transparent';
        } else if (selectedIds.length < 4) {
          selectedIds.push(cardId);
          img.style.borderColor = '#f1c40f';
        }
        $('kanuDesc').textContent = img.dataset.cardDesc || '';
        const btn = $('kanuConfirmBtn');
        btn.textContent = `确定（${selectedIds.length}/4）`;
        btn.disabled = selectedIds.length !== 4;
        btn.style.opacity = selectedIds.length === 4 ? '1' : '0.5';
      };
    });

    $('kanuConfirmBtn').onclick = () => {
      if (selectedIds.length === 4) {
        socket.emit('kanuSelectCards', { cardIds: selectedIds });
      }
    };
  });
});

socket.on('kanuEnd', () => {
  const panel = document.getElementById('kanuPanel');
  if (panel) panel.remove();
});

socket.on('myAssetAuctionStart', ({ assetType, assetName, auctionItem, sellerId, sellerName, sellerColor, currentBidderId, currentBidderName, currentBidderColor, startBid }) => {
  isJailMap = true;
  
  const boardEl = $('board');
  if (!boardEl) return;
  
  startBid = startBid || 0;
  
  const panel = document.createElement('div');
  panel.id = 'auctionPanel';
  panel.style.position = 'absolute';
  panel.style.top = '0';
  panel.style.left = '0';
  panel.style.right = '0';
  panel.style.bottom = '0';
  panel.style.zIndex = '100';
  panel.style.pointerEvents = 'auto';
  panel.style.display = 'grid';
  panel.style.gridTemplateColumns = 'repeat(4, 1fr)';
  panel.style.gridTemplateRows = 'repeat(6, 1fr)';
  panel.style.gap = '4px';
  panel.style.background = '#1a2a4a';

  const isMyTurn = currentBidderId === myId;
  let imgStyle = '';
  let descText = '';

  if (assetType === 'pet') {
    const isCwq = auctionItem.petImage && auctionItem.petImage.startsWith('cw');
    const petSrc = isCwq ? `/drawable/chongwu/chongwu2/${auctionItem.petImage}` : `/drawable/chongwu/${auctionItem.petImage}`;
    imgStyle = `background-image: url('${petSrc}');`;
    descText = auctionItem.petName ? `${auctionItem.petName}：${auctionItem.petDesc}` : '宠物拍卖';
  } else if (assetType === 'property') {
    const imageName = propertyImageMap[auctionItem.propertyName] || auctionItem.propertyName.toLowerCase();
    imgStyle = `background-image: url('/drawable/ditu/${imageName}.png');`;
    descText = `${auctionItem.propertyName}：地价${auctionItem.propertyPrice}`;
  } else if (assetType === 'diamond') {
    imgStyle = `background-image: url('/drawable/ditu/zuanshi.png');`;
    descText = '钻石拍卖';
  } else if (assetType === 'card') {
    imgStyle = `background-image: url('/drawable/kapian/${auctionItem.card.image}.png');`;
    descText = auctionItem.card.description;
  }
  
  panel.innerHTML = `
    <style>
      #auctionPanel button { white-space: nowrap; min-width: 0; }
      #auctionPanel button:disabled { background: #000 !important; color: transparent !important; opacity: 1 !important; }
      #auctionPanel #auctionFrame { background: #000 !important; color: #fff !important; }
      #auctionPanel #auctionPassBtn { background: #000 !important; }
      #auctionPanel #auctionPassBtn:disabled { background: #000 !important; color: transparent !important; }
    </style>
    <div id="auctionCardImg" style="grid-row: 1 / 4; grid-column: 1 / 5; ${imgStyle} background-size: contain; background-position: center; background-repeat: no-repeat; pointer-events: auto; border-radius: 8px;"></div>
    <div id="auctionCardDesc" style="grid-row: 4; grid-column: 1 / 5; background: #000; display: flex; align-items: center; justify-content: center; pointer-events: auto; border-radius: 8px; color: #fff; font-size: clamp(14px,4vw,28px); padding: 4px; text-align: center;">${descText}</div>
    <button id="auctionFrame" style="grid-row: 5; grid-column: 1; pointer-events: auto; border-radius: 8px; background: #000; color: #fff; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled>${startBid}</button>
    <button id="auctionConfirmBtn" style="grid-row: 5; grid-column: 2; pointer-events: auto; border-radius: 8px; background: #000; color: transparent; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled>确定</button>
    <button id="auctionClearBtn" style="grid-row: 5; grid-column: 3; pointer-events: auto; border-radius: 8px; background: #000; color: transparent; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled>撤回</button>
    <button id="auctionPassBtn" style="grid-row: 5; grid-column: 4; pointer-events: auto; border-radius: 8px; background: #000; color: #fff; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>弃权</button>
    <button id="auctionAdd1Btn" style="grid-row: 6; grid-column: 1; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+1</button>
    <button id="auctionAdd2Btn" style="grid-row: 6; grid-column: 2; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+2</button>
    <button id="auctionAdd5Btn" style="grid-row: 6; grid-column: 3; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+5</button>
    <button id="auctionAdd10Btn" style="grid-row: 6; grid-column: 4; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+10</button>
  `;
  
  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);
  
  if (currentBidderId === sellerId) {
    $('areaE').innerHTML = `${coloredName(sellerName, sellerColor)}拍卖${assetName}，请设置底价`;
  } else {
    $('areaE').innerHTML = `${coloredName(sellerName, sellerColor)}拍卖${assetName}（底价${startBid}），轮到${coloredName(currentBidderName, currentBidderColor)}出价`;
  }
  
  if (isMyTurn) {
    $('auctionAdd1Btn').onclick = () => socket.emit('auctionAdd', 1);
    $('auctionAdd2Btn').onclick = () => socket.emit('auctionAdd', 2);
    $('auctionAdd5Btn').onclick = () => socket.emit('auctionAdd', 5);
    $('auctionAdd10Btn').onclick = () => socket.emit('auctionAdd', 10);
    $('auctionClearBtn').onclick = () => socket.emit('auctionClear');
    $('auctionPassBtn').onclick = () => socket.emit('auctionPass');
    $('auctionConfirmBtn').onclick = () => socket.emit('auctionConfirm');
  }
});

socket.on('propertyAuctionStart', ({ property, currentBidderId, currentBidderName, currentBidderColor }) => {
  isJailMap = true;
  
  const boardEl = $('board');
  if (!boardEl) return;
  
  const panel = document.createElement('div');
  panel.id = 'auctionPanel';
  panel.style.position = 'absolute';
  panel.style.top = '0';
  panel.style.left = '0';
  panel.style.right = '0';
  panel.style.bottom = '0';
  panel.style.zIndex = '100';
  panel.style.pointerEvents = 'auto';
  panel.style.display = 'grid';
  panel.style.gridTemplateColumns = 'repeat(4, 1fr)';
  panel.style.gridTemplateRows = 'repeat(6, 1fr)';
  panel.style.gap = '4px';
  panel.style.background = '#1a2a4a';
  
  const isMyTurn = currentBidderId === myId;
  const imageName = propertyImageMap[property.name] || property.name.toLowerCase();
  const imgSrc = `/drawable/ditu/${imageName}.png`;
  const propDesc = `${property.name}：地价${property.price}`;
  
  panel.innerHTML = `
    <style>
      #auctionPanel button:disabled { background: #000 !important; color: transparent !important; opacity: 1 !important; }
      #auctionPanel #auctionFrame { background: #000 !important; color: #fff !important; }
      #auctionPanel #auctionPassBtn { background: #000 !important; }
      #auctionPanel #auctionPassBtn:disabled { background: #000 !important; color: transparent !important; }
    </style>
    <div id="auctionCardImg" style="grid-row: 1 / 4; grid-column: 1 / 5; background-image: url('${imgSrc}'); background-size: contain; background-position: center; background-repeat: no-repeat; pointer-events: auto; border-radius: 8px;"></div>
    <div id="auctionCardDesc" style="grid-row: 4; grid-column: 1 / 5; background: #000; display: flex; align-items: center; justify-content: center; pointer-events: auto; border-radius: 8px; color: #fff; font-size: clamp(12px,3vw,20px); padding: 8px; text-align: center;">${propDesc}</div>
    <button id="auctionFrame" style="grid-row: 5; grid-column: 1; pointer-events: auto; border-radius: 8px; background: #000; color: #fff; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled></button>
    <button id="auctionConfirmBtn" style="grid-row: 5; grid-column: 2; pointer-events: auto; border-radius: 8px; background: #000; color: transparent; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled>确定</button>
    <button id="auctionClearBtn" style="grid-row: 5; grid-column: 3; pointer-events: auto; border-radius: 8px; background: #000; color: transparent; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled>撤回</button>
    <button id="auctionPassBtn" style="grid-row: 5; grid-column: 4; pointer-events: auto; border-radius: 8px; background: #000; color: #fff; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>弃权</button>
    <button id="auctionAdd1Btn" style="grid-row: 6; grid-column: 1; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+1</button>
    <button id="auctionAdd2Btn" style="grid-row: 6; grid-column: 2; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+2</button>
    <button id="auctionAdd5Btn" style="grid-row: 6; grid-column: 3; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+5</button>
    <button id="auctionAdd10Btn" style="grid-row: 6; grid-column: 4; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+10</button>
  `;
  
  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);
  
  $('areaE').innerHTML = `${coloredName(currentBidderName, currentBidderColor)}发起拍卖：${property.name}`;
  
  const add1Btn = $('auctionAdd1Btn');
  const add2Btn = $('auctionAdd2Btn');
  const add5Btn = $('auctionAdd5Btn');
  const add10Btn = $('auctionAdd10Btn');
  const clearBtn = $('auctionClearBtn');
  const passBtn = $('auctionPassBtn');
  const confirmBtn = $('auctionConfirmBtn');
  
  if (isMyTurn) {
    add1Btn.onclick = () => socket.emit('auctionAdd', 1);
    add2Btn.onclick = () => socket.emit('auctionAdd', 2);
    add5Btn.onclick = () => socket.emit('auctionAdd', 5);
    add10Btn.onclick = () => socket.emit('auctionAdd', 10);
    clearBtn.onclick = () => socket.emit('auctionClear');
    passBtn.onclick = () => socket.emit('auctionPass');
    confirmBtn.onclick = () => socket.emit('auctionConfirm');
  }
});

socket.on('petAuctionStart', ({ petImage, petName, petDesc, currentBidderId, currentBidderName, currentBidderColor, qiyuSource }) => {
  isJailMap = true;

  const boardEl = $('board');
  if (!boardEl) return;

  const panel = document.createElement('div');
  panel.id = 'auctionPanel';
  panel.style.position = 'absolute';
  panel.style.top = '0';
  panel.style.left = '0';
  panel.style.right = '0';
  panel.style.bottom = '0';
  panel.style.zIndex = '100';
  panel.style.pointerEvents = 'auto';
  panel.style.display = 'grid';
  panel.style.gridTemplateColumns = 'repeat(4, 1fr)';
  panel.style.gridTemplateRows = 'repeat(6, 1fr)';
  panel.style.gap = '4px';
  panel.style.background = '#1a2a4a';

  const isMyTurn = currentBidderId === myId;
  const isCwqAuction = petImage && petImage.startsWith('cw');
  const imgSrc = petImage ? (isCwqAuction ? `/drawable/chongwu/chongwu2/${petImage}` : `/drawable/chongwu/${petImage}`) : '';
  const descText = petName ? `${petName}：${petDesc}` : '宠物拍卖';
  
  panel.innerHTML = `
    <style>
      #auctionPanel button:disabled { background: #000 !important; color: transparent !important; opacity: 1 !important; }
      #auctionPanel #auctionFrame { background: #000 !important; color: #fff !important; }
      #auctionPanel #auctionPassBtn { background: #000 !important; }
      #auctionPanel #auctionPassBtn:disabled { background: #000 !important; color: transparent !important; }
    </style>
    <div id="auctionCardImg" style="grid-row: 1 / 4; grid-column: 1 / 5; ${imgSrc ? `background-image: url('${imgSrc}');` : ''} background-size: contain; background-position: center; background-repeat: no-repeat; pointer-events: auto; border-radius: 8px;"></div>
    <div id="auctionCardDesc" style="grid-row: 4; grid-column: 1 / 5; background: #000; display: flex; align-items: center; justify-content: center; pointer-events: auto; border-radius: 8px; color: #fff; font-size: clamp(12px,3vw,20px); padding: 8px; text-align: center;">${descText}</div>
    <button id="auctionFrame" style="grid-row: 5; grid-column: 1; pointer-events: auto; border-radius: 8px; background: #000; color: #fff; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled></button>
    <button id="auctionConfirmBtn" style="grid-row: 5; grid-column: 2; pointer-events: auto; border-radius: 8px; background: #000; color: transparent; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled>确定</button>
    <button id="auctionClearBtn" style="grid-row: 5; grid-column: 3; pointer-events: auto; border-radius: 8px; background: #000; color: transparent; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled>撤回</button>
    <button id="auctionPassBtn" style="grid-row: 5; grid-column: 4; pointer-events: auto; border-radius: 8px; background: #000; color: #fff; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>弃权</button>
    <button id="auctionAdd1Btn" style="grid-row: 6; grid-column: 1; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+1</button>
    <button id="auctionAdd2Btn" style="grid-row: 6; grid-column: 2; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+2</button>
    <button id="auctionAdd5Btn" style="grid-row: 6; grid-column: 3; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+5</button>
    <button id="auctionAdd10Btn" style="grid-row: 6; grid-column: 4; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+10</button>
  `;
  
  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);
  
  if (qiyuSource === '走私贩子') {
    $('areaE').innerHTML = '走私贩子:抽取并拍卖一只宠物';
  } else {
    $('areaE').innerHTML = `${coloredName(currentBidderName, currentBidderColor)}发起宠物拍卖`;
  }
  fitAreaEText();
  
  const add1Btn = $('auctionAdd1Btn');
  const add2Btn = $('auctionAdd2Btn');
  const add5Btn = $('auctionAdd5Btn');
  const add10Btn = $('auctionAdd10Btn');
  const clearBtn = $('auctionClearBtn');
  const passBtn = $('auctionPassBtn');
  const confirmBtn = $('auctionConfirmBtn');
  
  if (isMyTurn) {
    add1Btn.onclick = () => socket.emit('auctionAdd', 1);
    add2Btn.onclick = () => socket.emit('auctionAdd', 2);
    add5Btn.onclick = () => socket.emit('auctionAdd', 5);
    add10Btn.onclick = () => socket.emit('auctionAdd', 10);
    clearBtn.onclick = () => socket.emit('auctionClear');
    passBtn.onclick = () => socket.emit('auctionPass');
    confirmBtn.onclick = () => socket.emit('auctionConfirm');
  }
});

socket.on('auctionStart', ({ card1, card2, card, playerCard, currentBidderId, currentBidderName, currentBidderColor }) => {
  console.log('DEBUG auctionStart received:', { card1, card2, card, playerCard });
  
  let finalCard1 = card1;
  let finalCard2 = card2;
  if (!card1 && !card2 && card && playerCard) {
    finalCard1 = card;
    finalCard2 = playerCard;
    console.log('DEBUG: Converted card/playerCard to card1/card2');
  } else if (!card1 && !card2 && card && !playerCard) {
    console.log('DEBUG: single card auction');
    finalCard1 = card;
    finalCard2 = null;
  } else {
    console.log('DEBUG: No conversion, finalCard1=' + (finalCard1?.name || 'undefined') + ' finalCard2=' + (finalCard2?.name || 'undefined'));
  }
  
  console.log('DEBUG finalCard1:', finalCard1);
  console.log('DEBUG finalCard2:', finalCard2);
  if (!finalCard1) { console.error('ERROR: finalCard1 is null/undefined!'); }
  if (!finalCard2) { console.error('ERROR: finalCard2 is null/undefined!'); }
  
  window.currentAuctionCard1 = finalCard1;
  window.currentAuctionCard2 = finalCard2;
  
  isJailMap = true;

  const boardEl = $('board');
  if (!boardEl) return;

  const panel = document.createElement('div');
  panel.id = 'auctionPanel';
  panel.style.position = 'absolute';
  panel.style.top = '0';
  panel.style.left = '0';
  panel.style.right = '0';
  panel.style.bottom = '0';
  panel.style.zIndex = '100';
  panel.style.pointerEvents = 'auto';
  panel.style.display = 'grid';
  panel.style.gridTemplateColumns = 'repeat(4, 1fr)';
  panel.style.gridTemplateRows = 'repeat(6, 1fr)';
  panel.style.gap = '4px';
  panel.style.background = '#1a2a4a';

  const isMyTurn = currentBidderId === myId;

  const isSingleCard = !finalCard2;
  try {
    const card1Col = isSingleCard ? '1 / 5' : '1 / 3';
    const card2Col = isSingleCard ? '' : '3 / 5';
    const descCol = '1 / 5';
    panel.innerHTML = `
      <style>
        #auctionPanel button:disabled { background: #000 !important; color: transparent !important; opacity: 1 !important; }
        #auctionPanel #auctionFrame { background: #000 !important; color: #fff !important; }
        #auctionPanel #auctionPassBtn { background: #000 !important; }
        #auctionPanel #auctionPassBtn:disabled { background: #000 !important; color: transparent !important; }
      </style>
      <div style="grid-row: 1 / 4; grid-column: ${card1Col}; background-image: url('/drawable/kapian/${finalCard1.image}.png'); background-size: contain; background-position: center; background-repeat: no-repeat; pointer-events: auto; border-radius: 8px;"></div>
      ${isSingleCard ? '' : `<div style="grid-row: 1 / 4; grid-column: ${card2Col}; background-image: url('/drawable/kapian/${finalCard2.image}.png'); background-size: contain; background-position: center; background-repeat: no-repeat; pointer-events: auto; border-radius: 8px;"></div>`}
      ${isSingleCard
        ? `<div style="grid-row: 4; grid-column: 1 / 5; background: #000; display: flex; align-items: center; justify-content: center; pointer-events: auto; border-radius: 8px; color: #fff; font-size: clamp(14px,4vw,28px); padding: 4px; text-align: center;">${finalCard1.description}</div>`
        : `<div style="grid-row: 4; grid-column: 1 / 3; background: #000; display: flex; align-items: center; justify-content: center; pointer-events: auto; border-radius: 8px; color: #fff; font-size: clamp(10px,2.5vw,18px); padding: 4px; text-align: center;">${finalCard1.description}</div>
      <div style="grid-row: 4; grid-column: 3 / 5; background: #000; display: flex; align-items: center; justify-content: center; pointer-events: auto; border-radius: 8px; color: #fff; font-size: clamp(10px,2.5vw,18px); padding: 4px; text-align: center;">${finalCard2.description}</div>`}
      <button id="auctionFrame" style="grid-row: 5; grid-column: 1; pointer-events: auto; border-radius: 8px; background: #000; color: #fff; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled></button>
      <button id="auctionConfirmBtn" style="grid-row: 5; grid-column: 2; pointer-events: auto; border-radius: 8px; background: #000; color: transparent; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled>确定</button>
      <button id="auctionClearBtn" style="grid-row: 5; grid-column: 3; pointer-events: auto; border-radius: 8px; background: #000; color: transparent; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled>撤回</button>
      <button id="auctionPassBtn" style="grid-row: 5; grid-column: 4; pointer-events: auto; border-radius: 8px; background: #000; color: #fff; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>弃权</button>
      <button id="auctionAdd1Btn" style="grid-row: 6; grid-column: 1; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+1</button>
      <button id="auctionAdd2Btn" style="grid-row: 6; grid-column: 2; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+2</button>
      <button id="auctionAdd5Btn" style="grid-row: 6; grid-column: 3; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+5</button>
      <button id="auctionAdd10Btn" style="grid-row: 6; grid-column: 4; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+10</button>
    `;
  } catch(e) {
    console.error('ERROR auctionStart panel.innerHTML failed:', e);
    console.error('finalCard1:', finalCard1, 'finalCard2:', finalCard2);
  }

  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);

  const displayName1 = finalCard1 ? finalCard1.name : '?';
  const displayName2 = finalCard2 ? finalCard2.name : null;
  $('areaE').innerHTML = displayName2
    ? `${coloredName(currentBidderName, currentBidderColor)}发起拍卖：${displayName1} + ${displayName2}`
    : `${coloredName(currentBidderName, currentBidderColor)}发起拍卖：${displayName1}`;
  
  const add1Btn = $('auctionAdd1Btn');
  const add2Btn = $('auctionAdd2Btn');
  const add5Btn = $('auctionAdd5Btn');
  const add10Btn = $('auctionAdd10Btn');
  const clearBtn = $('auctionClearBtn');
  const passBtn = $('auctionPassBtn');
  const confirmBtn = $('auctionConfirmBtn');
  
  if (add1Btn) {
    add1Btn.onclick = () => socket.emit('auctionAdd', 1);
  }
  if (add2Btn) {
    add2Btn.onclick = () => socket.emit('auctionAdd', 2);
  }
  if (add5Btn) {
    add5Btn.onclick = () => socket.emit('auctionAdd', 5);
  }
  if (add10Btn) {
    add10Btn.onclick = () => socket.emit('auctionAdd', 10);
  }
  if (clearBtn) {
    clearBtn.onclick = () => socket.emit('auctionClear');
  }
  if (passBtn) {
    passBtn.onclick = () => socket.emit('auctionPass');
  }
  if (confirmBtn) {
    confirmBtn.onclick = () => socket.emit('auctionConfirm');
  }
});

socket.on('auctionUpdate', ({ myBid, currentBid, roundStartBid }) => {
  const frameEl = $('auctionFrame');
  if (frameEl) frameEl.textContent = myBid;
  
  const startBid = roundStartBid || 0;
  const passBtn = $('auctionPassBtn');
  const confirmBtn = $('auctionConfirmBtn');
  const clearBtn = $('auctionClearBtn');
  if (passBtn) {
    passBtn.disabled = myBid > startBid;
    passBtn.style.color = myBid > startBid ? 'transparent' : '#fff';
  }
  if (confirmBtn) {
    confirmBtn.disabled = myBid <= startBid;
    confirmBtn.style.color = myBid <= startBid ? 'transparent' : '#fff';
  }
  if (clearBtn) {
    clearBtn.disabled = myBid <= startBid;
    clearBtn.style.color = myBid <= startBid ? 'transparent' : '#fff';
  }
});

socket.on('auctionPassed', () => {
  const pnl = $('auctionPanel');
  if (pnl) pnl.remove();
  $('areaE').textContent = '你已退出拍卖';
});

socket.on('auctionNextBidder', ({ bidderId, bidderName, bidderColor, currentBid, card, card1, card2, roundStartBid, lastBidderName, lastBidderColor, isPetAuction, isPropertyAuction, isDiamondAuction, isCardAuction, petImage, petName, petDesc, property, assetName, sellerId, sellerName, sellerColor }) => {
  // 调试：检查收到的数据
  console.log('DEBUG auctionNextBidder received:', { card, card1, card2 });
  
  // 处理不同格式的拍卖数据
  let finalCard1 = card1;
  let finalCard2 = card2;
  if (!card1 && !card2 && card) {
    finalCard1 = card;
    finalCard2 = window.currentAuctionCard2; // 使用全局存储的card2
    console.log('DEBUG auctionNextBidder: Using card and stored card2:', { finalCard1, finalCard2 });
  }
  
  const isMyTurn = bidderId === myId;
  const startBid = roundStartBid || 0;

  const pnl = $('auctionPanel');
  if (pnl) pnl.remove();

  const boardEl = $('board');
  if (!boardEl) return;

  const panel = document.createElement('div');
  panel.id = 'auctionPanel';
  panel.style.position = 'absolute';
  panel.style.top = '0';
  panel.style.left = '0';
  panel.style.right = '0';
  panel.style.bottom = '0';
  panel.style.zIndex = '100';
  panel.style.pointerEvents = 'auto';
  panel.style.display = 'grid';
  panel.style.gridTemplateColumns = 'repeat(4, 1fr)';
  panel.style.gridTemplateRows = 'repeat(6, 1fr)';
  panel.style.gap = '4px';
  panel.style.background = '#1a2a4a';

  let imgStyle = '';
  let imgStyle1 = '';
  let imgStyle2 = '';
  let descText = '';
  let descText1 = '';
  let descText2 = '';
  if (isPetAuction && petImage) {
    const isCwq = petImage.startsWith('cw');
    const petSrc = isCwq ? `/drawable/chongwu/chongwu2/${petImage}` : `/drawable/chongwu/${petImage}`;
    imgStyle = `background-image: url('${petSrc}');`;
    descText = petName ? `${petName}：${petDesc}` : '宠物拍卖';
  } else if (isPropertyAuction && property) {
    const imageName = propertyImageMap[property.name] || property.name.toLowerCase();
    imgStyle = `background-image: url('/drawable/ditu/${imageName}.png');`;
    descText = `${property.name}：地价${property.price}`;
  } else if (isDiamondAuction) {
    imgStyle = `background-image: url('/drawable/ditu/zuanshi.png');`;
    descText = '钻石拍卖';
  } else if (finalCard1 && finalCard2) {
    imgStyle1 = `background-image: url('/drawable/kapian/${finalCard1.image}.png');`;
    imgStyle2 = `background-image: url('/drawable/kapian/${finalCard2.image}.png');`;
    descText1 = finalCard1.description;
    descText2 = finalCard2.description;
  } else if (isCardAuction && card) {
    imgStyle = `background-image: url('/drawable/kapian/${card.image}.png');`;
    descText = card.description;
  } else if (card) {
    imgStyle = `background-image: url('/drawable/kapian/${card.image}.png');`;
    descText = card.description;
  } else if (finalCard1 && !finalCard2) {
    imgStyle = `background-image: url('/drawable/kapian/${finalCard1.image}.png');`;
    descText = finalCard1.description;
  }

  let cardImgHtml = '';
  let cardDescHtml = '';
  if (finalCard1 && finalCard2) {
    cardImgHtml = `
      <div style="grid-row: 1 / 4; grid-column: 1 / 3; ${imgStyle1} background-size: contain; background-position: center; background-repeat: no-repeat; pointer-events: auto; border-radius: 8px;"></div>
      <div style="grid-row: 1 / 4; grid-column: 3 / 5; ${imgStyle2} background-size: contain; background-position: center; background-repeat: no-repeat; pointer-events: auto; border-radius: 8px;"></div>
      <div style="grid-row: 4; grid-column: 1 / 3; background: #000; display: flex; align-items: center; justify-content: center; pointer-events: auto; border-radius: 8px; color: #fff; font-size: clamp(10px,2.5vw,18px); padding: 4px; text-align: center;">${descText1}</div>
      <div style="grid-row: 4; grid-column: 3 / 5; background: #000; display: flex; align-items: center; justify-content: center; pointer-events: auto; border-radius: 8px; color: #fff; font-size: clamp(10px,2.5vw,18px); padding: 4px; text-align: center;">${descText2}</div>
    `;
  } else {
    cardImgHtml = `<div id="auctionCardImg" style="grid-row: 1 / 4; grid-column: 1 / 5; ${imgStyle} background-size: contain; background-position: center; background-repeat: no-repeat; pointer-events: auto; border-radius: 8px;"></div>`;
    cardDescHtml = `<div id="auctionCardDesc" style="grid-row: 4; grid-column: 1 / 5; background: #000; display: flex; align-items: center; justify-content: center; pointer-events: auto; border-radius: 8px; color: #fff; font-size: clamp(14px,4vw,28px); padding: 8px; text-align: center;">${descText}</div>`;
  }

  panel.innerHTML = `
    <style>
      #auctionPanel button:disabled { background: #000 !important; color: transparent !important; opacity: 1 !important; }
      #auctionPanel #auctionFrame { background: #000 !important; color: #fff !important; }
      #auctionPanel #auctionPassBtn { background: #000 !important; }
      #auctionPanel #auctionPassBtn:disabled { background: #000 !important; color: transparent !important; }
    </style>
    ${cardImgHtml}
    ${cardDescHtml}
    <button id="auctionFrame" style="grid-row: 5; grid-column: 1; pointer-events: auto; border-radius: 8px; background: #000; color: #fff; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled>${currentBid}</button>
    <button id="auctionConfirmBtn" style="grid-row: 5; grid-column: 2; pointer-events: auto; border-radius: 8px; background: #000; color: transparent; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled>确定</button>
    <button id="auctionClearBtn" style="grid-row: 5; grid-column: 3; pointer-events: auto; border-radius: 8px; background: #000; color: transparent; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" disabled>撤回</button>
    <button id="auctionPassBtn" style="grid-row: 5; grid-column: 4; pointer-events: auto; border-radius: 8px; background: #000; color: #fff; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>弃权</button>
    <button id="auctionAdd1Btn" style="grid-row: 6; grid-column: 1; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+1</button>
    <button id="auctionAdd2Btn" style="grid-row: 6; grid-column: 2; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+2</button>
    <button id="auctionAdd5Btn" style="grid-row: 6; grid-column: 3; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+5</button>
    <button id="auctionAdd10Btn" style="grid-row: 6; grid-column: 4; pointer-events: auto; border-radius: 8px; background: #000; color: ${!isMyTurn ? 'transparent' : '#fff'}; border: 2px solid transparent; font-size: clamp(12px,3vw,20px); box-sizing: border-box;" ${!isMyTurn ? 'disabled' : ''}>+10</button>
  `;

  boardEl.appendChild(panel);

  if (lastBidderName) {
    $('areaE').innerHTML = `${coloredName(lastBidderName, lastBidderColor)}出价${startBid}，轮到${coloredName(bidderName, bidderColor)}出价`;
  } else {
    $('areaE').innerHTML = `轮到${coloredName(bidderName, bidderColor)}出价`;
  }
  
  const add1Btn = $('auctionAdd1Btn');
  const add2Btn = $('auctionAdd2Btn');
  const add5Btn = $('auctionAdd5Btn');
  const add10Btn = $('auctionAdd10Btn');
  const clearBtn = $('auctionClearBtn');
  const passBtn = $('auctionPassBtn');
  const confirmBtn = $('auctionConfirmBtn');
  
  if (add1Btn) add1Btn.onclick = () => socket.emit('auctionAdd', 1);
  if (add2Btn) add2Btn.onclick = () => socket.emit('auctionAdd', 2);
  if (add5Btn) add5Btn.onclick = () => socket.emit('auctionAdd', 5);
  if (add10Btn) add10Btn.onclick = () => socket.emit('auctionAdd', 10);
  if (clearBtn) clearBtn.onclick = () => socket.emit('auctionClear');
  if (passBtn) passBtn.onclick = () => socket.emit('auctionPass');
  if (confirmBtn) confirmBtn.onclick = () => socket.emit('auctionConfirm');
});

socket.on('auctionBidderConfirmed', ({ bidderName, bidderColor, bid }) => {
  const auctionNumber = $('auctionNumber');
  if (auctionNumber) {
    auctionNumber.textContent = bid;
  }
  
  const pnl = $('auctionPanel');
  if (pnl) {
    const buttons = pnl.querySelectorAll('button');
    buttons.forEach(btn => {
      btn.disabled = true;
      btn.style.opacity = '0.5';
    });
  }
});

socket.on('petShopClosed', () => {
  const panel = document.getElementById('petShopPanel');
  if (panel) panel.remove();
});

socket.on('nearBankrupt', ({ playerId, playerName, playerColor, properties }) => {
  const isMe = playerId === myId;
  $('areaE').innerHTML = `${coloredName(playerName, playerColor)}濒破产，请选择地产半价卖出`;
  if (isMe) {
    document.querySelectorAll('.space').forEach(spaceEl => {
      const spaceId = parseInt(spaceEl.dataset.id);
      const isMyProp = properties.some(p => p.id === spaceId);
      if (isMyProp) {
        spaceEl.style.border = '3px solid red';
        spaceEl.style.cursor = 'pointer';
        spaceEl.onclick = () => {
          document.querySelectorAll('.space').forEach(s => {
            s.style.border = '';
            s.style.cursor = '';
            s.onclick = null;
          });
          socket.emit('sellProperty', { propertyId: spaceId });
        };
      }
    });
  }
});

socket.on('nearBankruptResolved', ({ playerId }) => {
  $('areaE').innerHTML = '';
  const cur = players[currentPlayerIdx];
  if (cur && cur.id === myId) {
    document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
    const endTurnBtn = document.getElementById('endTurnBtn');
    if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
  }
});

socket.on('playerBankrupt', ({ playerId, playerName, playerColor, rank, character, variant }) => {
  document.querySelectorAll('.space').forEach(s => { s.style.border = ''; s.style.cursor = ''; s.onclick = null; });
  hidePropertyOverlay();
  const imgPath = `/drawable/juese/${character}${variant || '2'}.png`;
  showTip(imgPath, `${playerName}破产！第${rank}名`);
  refreshPlayerCards();
});

socket.on('gameOver', ({ winnerName, winnerColor, winnerCharacter, winnerVariant, rankings }) => {
  const boardEl = $('board');
  if (!boardEl) return;
  let panel = document.getElementById('gameOverPanel');
  if (panel) panel.remove();
  panel = document.createElement('div');
  panel.id = 'gameOverPanel';
  panel.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:200;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,1);color:#fff;';
  let html = `<div style="display:flex;align-items:center;margin-bottom:clamp(16px,4vh,32px);"><img src="/drawable/juese/${winnerCharacter}${winnerVariant || '2'}.png" style="width:clamp(60px,10vw,120px);height:clamp(60px,10vw,120px);margin-right:clamp(8px,2vw,16px);"><div style="font-size:clamp(24px,5vw,56px);font-weight:bold;color:#fff;">${winnerName}获胜！</div></div>`;
  rankings.forEach((r, i) => {
    if (i === 0) return;
    const label = `第${['二','三','四','五','六'][i-1] || (i+1)}名`;
    html += `<div style="font-size:clamp(14px,3vw,28px);margin:clamp(4px,1vh,8px) 0;display:flex;align-items:center;"><img src="/drawable/juese/${r.character}${r.variant || '2'}.png" style="width:clamp(24px,4vw,48px);height:clamp(24px,4vw,48px);margin-right:clamp(6px,1.5vw,12px);">${label}：${r.name}</div>`;
  });
  html += `<div style="display:flex;gap:clamp(8px,2vw,16px);margin-top:clamp(16px,4vh,32px);"><button id="playAgainBtn" style="padding:clamp(8px,2vw,14px) clamp(20px,5vw,48px);font-size:clamp(14px,3vw,24px);background:#000;color:#fff;border:2px solid #fff;border-radius:8px;cursor:pointer;">再来一局</button></div>`;
  panel.innerHTML = html;
  document.body.appendChild(panel);
  document.getElementById('playAgainBtn').onclick = () => {
    panel.remove();
    socket.emit('restart');
  };
});

socket.on('auctionEnd', ({ winnerName, winnerId, winnerColor, bid, card, card1, card2, isPetAuction, isPropertyAuction, isDiamondAuction, isCardAuction, petImage, petName, propertyName, assetName, sellerId, sellerName, sellerColor }) => {
  // 调试：检查收到的数据
  console.log('DEBUG auctionEnd received:', { card, card1, card2 });
  
  // 处理不同格式的拍卖数据
  let finalCard1 = card1;
  let finalCard2 = card2;
  if (!card1 && !card2 && card) {
    finalCard1 = card;
    finalCard2 = window.currentAuctionCard2; // 使用全局存储的card2
    console.log('DEBUG auctionEnd: Using card and stored card2:', { finalCard1, finalCard2 });
  }
  
  isJailMap = false;
  const pnl = $('auctionPanel');
  if (pnl) pnl.remove();
  document.getElementById('areaF').innerHTML = '';

  // 获取显示名称（隐藏卡显示伪装名称）
  const getDisplayName = (c) => {
    if (!c) return '';
    if (c.id === 6 || c.name === '隐藏卡') return '隐藏卡';
    return c.name;
  };

  if (winnerName) {
    let wonName = '';
    if (sellerId) {
      wonName = assetName || propertyName || '宠物';
    } else if (isPetAuction) {
      wonName = petName || '宠物';
    } else if (isPropertyAuction) {
      wonName = propertyName;
    } else if (finalCard1 && finalCard2) {
      wonName = getDisplayName(finalCard1) + ' + ' + getDisplayName(finalCard2);
    } else if (card) {
      wonName = getDisplayName(card);
    } else if (finalCard1) {
      wonName = getDisplayName(finalCard1);
    }
    $('areaE').innerHTML = `${coloredName(winnerName, winnerColor)}出价${bid}，拍得${wonName}`;
  } else {
    $('areaE').textContent = `拍卖结束，无人出价`;
  }
});

socket.on('xinjiangOwn', ({ spaceName, houseLevel, buildCost }) => {
  const areaF = document.getElementById('areaF');
  const areaE = $('areaE');
  if (houseLevel < 4) {
    areaE.textContent = `是否花$${buildCost}建房？`;
    let btns = '<button id="xjBackwardBtn" class="jail-btn">退1步</button>';
    btns += '<button id="xjForwardBtn" class="jail-btn">进1步</button>';
    btns += '<button id="xjBuildBtn" class="jail-btn">建房</button>';
    btns += '<button id="xjEndTurnBtn" class="jail-btn">结束</button>';
    areaF.innerHTML = btns;
    $('xjForwardBtn').onclick = () => {
      const b1 = $('xjForwardBtn'), b2 = $('xjBackwardBtn'), b3 = $('xjBuildBtn');
      if (b1) b1.remove(); if (b2) b2.remove(); if (b3) b3.remove();
      socket.emit('xinjiangMoveOwn', 'forward');
    };
    $('xjBackwardBtn').onclick = () => {
      const b1 = $('xjForwardBtn'), b2 = $('xjBackwardBtn'), b3 = $('xjBuildBtn');
      if (b1) b1.remove(); if (b2) b2.remove(); if (b3) b3.remove();
      socket.emit('xinjiangMoveOwn', 'backward');
    };
    $('xjBuildBtn').onclick = () => {
      socket.emit('xinjiangBuild');
    };
    $('xjEndTurnBtn').onclick = () => {
      areaF.innerHTML = '';
      doEndTurn();
    };
  } else {
    areaE.textContent = '已经满级';
    let btns = '<button id="xjBackwardBtn" class="jail-btn">退1步</button>';
    btns += '<button id="xjForwardBtn" class="jail-btn">进1步</button>';
    btns += '<button id="xjEndTurnBtn" class="jail-btn">结束</button>';
    areaF.innerHTML = btns;
    $('xjForwardBtn').onclick = () => {
      const b1 = $('xjForwardBtn'), b2 = $('xjBackwardBtn');
      if (b1) b1.remove(); if (b2) b2.remove();
      socket.emit('xinjiangMoveOwn', 'forward');
    };
    $('xjBackwardBtn').onclick = () => {
      const b1 = $('xjForwardBtn'), b2 = $('xjBackwardBtn');
      if (b1) b1.remove(); if (b2) b2.remove();
      socket.emit('xinjiangMoveOwn', 'backward');
    };
    $('xjEndTurnBtn').onclick = () => {
      areaF.innerHTML = '';
      doEndTurn();
    };
  }
});

socket.on('xinjiangAfterBuild', ({ spaceName, houseLevel, ownerName, ownerColor }) => {
  $('areaE').innerHTML = `${coloredName(ownerName, ownerColor)}的${spaceName}升级！`;
  const buildBtn = $('xjBuildBtn');
  if (buildBtn) buildBtn.remove();
  if (houseLevel >= 4) {
    const fwdBtn = $('xjForwardBtn');
    const bwdBtn = $('xjBackwardBtn');
    if (fwdBtn) fwdBtn.remove();
    if (bwdBtn) bwdBtn.remove();
  }
});

socket.on('xinjiangMoveOwnDone', () => {
  const fwdBtn = $('xjForwardBtn');
  const bwdBtn = $('xjBackwardBtn');
  const buildBtn = $('xjBuildBtn');
  if (fwdBtn) fwdBtn.remove();
  if (bwdBtn) bwdBtn.remove();
  if (buildBtn) buildBtn.remove();
  if (!$('xjEndTurnBtn')) {
    document.getElementById('areaF').innerHTML += '<button id="xjEndTurnBtn" class="jail-btn">结束</button>';
    $('xjEndTurnBtn').onclick = () => {
      document.getElementById('areaF').innerHTML = '';
      doEndTurn();
    };
  }
});

socket.on('xizangOwn', ({ spaceName, houseLevel, buildCost }) => {
  const areaF = document.getElementById('areaF');
  const areaE = $('areaE');
  if (houseLevel < 4) {
    areaE.textContent = `是否花$${buildCost}建房？是否下回合掷大点/小点？`;
    let btns = '<button id="xzBuildBtn" class="jail-btn">建房</button>';
    btns += '<button id="xzDiceHighBtn" class="jail-btn">掷大点</button>';
    btns += '<button id="xzDiceLowBtn" class="jail-btn">掷小点</button>';
    btns += '<button id="xzEndTurnBtn" class="jail-btn">结束</button>';
    areaF.innerHTML = btns;
    $('xzBuildBtn').onclick = () => {
      socket.emit('xizangBuildOwn');
    };
    $('xzDiceHighBtn').onclick = () => {
      $('xzDiceHighBtn').remove();
      $('xzDiceLowBtn').remove();
      socket.emit('xizangDiceHigh');
    };
    $('xzDiceLowBtn').onclick = () => {
      $('xzDiceHighBtn').remove();
      $('xzDiceLowBtn').remove();
      socket.emit('xizangDiceLow');
    };
    $('xzEndTurnBtn').onclick = () => {
      areaF.innerHTML = '';
      doEndTurn();
    };
  } else {
    areaE.textContent = '已经满级，是否下回合掷大点/小点？';
    let btns = '<button id="xzDiceHighBtn" class="jail-btn">掷大点</button>';
    btns += '<button id="xzDiceLowBtn" class="jail-btn">掷小点</button>';
    btns += '<button id="xzEndTurnBtn" class="jail-btn">结束</button>';
    areaF.innerHTML = btns;
    $('xzDiceHighBtn').onclick = () => {
      $('xzDiceHighBtn').remove();
      $('xzDiceLowBtn').remove();
      socket.emit('xizangDiceHigh');
    };
    $('xzDiceLowBtn').onclick = () => {
      $('xzDiceHighBtn').remove();
      $('xzDiceLowBtn').remove();
      socket.emit('xizangDiceLow');
    };
    $('xzEndTurnBtn').onclick = () => {
      areaF.innerHTML = '';
      doEndTurn();
    };
  }
});

socket.on('xizangAfterBuild', ({ spaceName, houseLevel, ownerName, ownerColor }) => {
  $('areaE').innerHTML = `${coloredName(ownerName, ownerColor)}的${spaceName}升级！`;
  const buildBtn = $('xzBuildBtn');
  if (buildBtn) buildBtn.remove();
});

socket.on('xinjiangMove', ({ canMoveBack, ownerName, ownerColor }) => {
  const cur = players[currentPlayerIdx];
  if (cur?.id === myId) {
    let btns = '';
    if (canMoveBack) {
      btns += '<button id="moveBackwardBtn" class="jail-btn">退1步</button>';
    }
    btns += '<button id="moveStayBtn" class="jail-btn">保持</button>';
    btns += '<button id="moveForwardBtn" class="jail-btn">进1步</button>';
    document.getElementById('areaF').innerHTML = btns;
  const forwardBtn = $('moveForwardBtn');
  const backwardBtn = $('moveBackwardBtn');
  const stayBtn = $('moveStayBtn');
  if (forwardBtn) {
    forwardBtn.onclick = () => {
      socket.emit('xinjiangMove', 'forward');
      document.getElementById('areaF').innerHTML = '';
    };
  }
  if (backwardBtn) {
    backwardBtn.onclick = () => {
      socket.emit('xinjiangMove', 'backward');
      document.getElementById('areaF').innerHTML = '';
    };
  }
  if (stayBtn) {
    stayBtn.onclick = () => {
      socket.emit('xinjiangMove', 'stay');
      document.getElementById('areaF').innerHTML = '';
    };
  }
  }
});

socket.on('xizangChoice', ({ ownerName, ownerColor }) => {
  const cur = players[currentPlayerIdx];
  if (cur?.id === myId) {
    let btns = '<button id="diceHighBtn" class="jail-btn">掷大点</button>';
    btns += '<button id="diceLowBtn" class="jail-btn">掷小点</button>';
    document.getElementById('areaF').innerHTML = btns;
  const highBtn = $('diceHighBtn');
  const lowBtn = $('diceLowBtn');
  if (highBtn) {
    highBtn.onclick = () => {
      socket.emit('xizangChoice', 'high');
      document.getElementById('areaF').innerHTML = '';
    };
  }
  if (lowBtn) {
    lowBtn.onclick = () => {
      socket.emit('xizangChoice', 'low');
      document.getElementById('areaF').innerHTML = '';
    };
  }
  }
});

socket.on('qinghaiHuyanChoice', ({ ownerName, ownerColor }) => {
  const cur = players[currentPlayerIdx];
  if (cur?.id === myId) {
    let btns = '<button id="qinghaiClearBtn" class="jail-btn">清除</button>';
    btns += '<button id="qinghaiKeepBtn" class="jail-btn">保留</button>';
    document.getElementById('areaF').innerHTML = btns;
    const clearBtn = $('qinghaiClearBtn');
    const keepBtn = $('qinghaiKeepBtn');
    if (clearBtn) {
      clearBtn.onclick = () => {
        socket.emit('qinghaiHuyanChoice', 'clear');
        document.getElementById('areaF').innerHTML = '';
      };
    }
    if (keepBtn) {
      keepBtn.onclick = () => {
        socket.emit('qinghaiHuyanChoice', 'keep');
        document.getElementById('areaF').innerHTML = '';
      };
    }
  }
});

socket.on('guangxiOwn', ({ spaceName, houseLevel, buildCost, ownerName, ownerColor }) => {
  const areaF = document.getElementById('areaF');
  const areaE = $('areaE');
  const showGuangxiButtons = () => {
    if (houseLevel < 4) {
      areaE.textContent = `是否花$${buildCost}建房？`;
    } else {
      areaE.textContent = '已经满级';
    }
    // 检查是否有其他玩家有地产
    const playersWithProperty = players.filter(p => p.id !== myId && !p.bankrupt && !p.sheltered && board.some(s => s.isProperty && s.owner === p.id));
    let btns = '';
    if (houseLevel < 4) {
      btns += '<button id="gxBuildBtn" class="jail-btn">建房</button>';
    }
    if (playersWithProperty.length > 0) {
      btns += '<button id="gxExchangeBtn" class="jail-btn">交换地产</button>';
    }
    btns += '<button id="gxEndTurnBtn" class="jail-btn">结束</button>';
    areaF.innerHTML = btns;
    if ($('gxBuildBtn')) {
      $('gxBuildBtn').onclick = () => { socket.emit('guangxiBuildOwn'); };
    }
    if ($('gxExchangeBtn')) {
      $('gxExchangeBtn').onclick = () => {
        areaF.innerHTML = '';
        areaE.innerHTML = `请选择玩家与${coloredName(ownerName, ownerColor)}交换广西`;
        guangxiOwnState = { ownerId: myId };
        socket.emit('guangxiStartExchange');
        document.querySelectorAll('.player-card').forEach(card => {
          const pid = card.dataset.card;
          if (pid && pid !== myId) {
            const targetPlayer = players.find(p => p.id === pid);
            if (targetPlayer && !targetPlayer.bankrupt && !targetPlayer.sheltered && board.some(s => s.isProperty && s.owner === pid)) {
              card.style.border = '3px solid white';
              card.style.cursor = 'pointer';
              card.onclick = () => {
                document.querySelectorAll('.player-card').forEach(c => { c.style.border = ''; c.style.cursor = ''; c.onclick = null; });
                socket.emit('guangxiSelectPlayer', pid);
              };
            }
          }
        });
      };
    }
    $('gxEndTurnBtn').onclick = () => { areaF.innerHTML = ''; doEndTurn(); };
  };
  showGuangxiButtons();
});

socket.on('guangxiNoProperty', ({ targetName, ownerName, ownerColor, buildCost, houseLevel }) => {
  $('areaE').textContent = `交换失败，${targetName}没有地产`;
  const areaF = document.getElementById('areaF');
  let btns = '';
  if (houseLevel < 4) {
    btns += '<button id="gxBuildBtn" class="jail-btn">建房</button>';
  }
  btns += '<button id="gxEndTurnBtn" class="jail-btn">结束</button>';
  areaF.innerHTML = btns;
  if ($('gxBuildBtn')) {
    $('gxBuildBtn').onclick = () => {
      socket.emit('guangxiBuildOwn');
    };
  }
  $('gxEndTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    doEndTurn();
  };
});

socket.on('guangxiAfterBuild', ({ spaceName, houseLevel, ownerName, ownerColor }) => {
  $('areaE').innerHTML = `${coloredName(ownerName, ownerColor)}的${spaceName}升级！`;
  const buildBtn = $('gxBuildBtn');
  if (buildBtn) buildBtn.remove();
});

socket.on('guangxiTargetChoice', ({ properties, ownerName, ownerColor, targetName, targetColor }) => {
  $('areaE').innerHTML = `请选择地产交换广西`;
  document.getElementById('areaF').innerHTML = '';
  const propertyIds = properties.map(p => p.id);
  document.querySelectorAll('.space').forEach(el => {
    const spaceId = parseInt(el.dataset.id);
    if (propertyIds.includes(spaceId)) {
      el.classList.add('highlighted');
      el.style.cursor = 'pointer';
      el.style.border = '2px solid #fff';
      el.style.boxShadow = '0 0 8px #fff';
      el.onclick = () => {
        document.querySelectorAll('.space').forEach(s => { s.classList.remove('highlighted'); s.style.cursor = ''; s.style.border = ''; s.style.boxShadow = ''; s.onclick = null; });
        socket.emit('guangxiTargetExchange', spaceId);
      };
    }
  });
});

socket.on('zheRenFengSelectProperty', ({ properties }) => {
  const propertyIds = properties.map(p => p.id);
  document.querySelectorAll('.space').forEach(el => {
    const spaceId = parseInt(el.dataset.id);
    if (propertyIds.includes(spaceId)) {
      el.classList.add('highlighted');
      el.style.cursor = 'pointer';
      el.style.border = '2px solid #fff';
      el.style.boxShadow = '0 0 8px #fff';
      el.onclick = () => {
        document.querySelectorAll('.space').forEach(s => { s.classList.remove('highlighted'); s.style.cursor = ''; s.style.border = ''; s.style.boxShadow = ''; s.onclick = null; });
        socket.emit('zheRenFengChooseProperty', { spaceId });
      };
    }
  });
});

socket.on('zheRenFengOwnerChoice', ({ spaceName, ownerName, ownerColor }) => {
  const areaF = document.getElementById('areaF');
  if (!areaF) return;
  areaF.innerHTML = `<button class="jail-btn" id="zrfPay10">-10</button><button class="jail-btn" id="zrfClose">${spaceName}停业</button>`;
  $('zrfPay10').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('zheRenFengOwnerResponse', { choice: 'pay10' });
  };
  $('zrfClose').onclick = () => {
    areaF.innerHTML = '';
    socket.emit('zheRenFengOwnerResponse', { choice: 'close' });
  };
});

socket.on('zheRenFengClearF', () => {
  const areaF = document.getElementById('areaF');
  if (areaF) areaF.innerHTML = '';
});

socket.on('guangxiExchangeDone', () => {
  const areaF = document.getElementById('areaF');
  areaF.innerHTML = '<button id="gxEndTurnBtn" class="jail-btn">结束</button>';
  $('gxEndTurnBtn').onclick = () => {
    areaF.innerHTML = '';
    doEndTurn();
  };
});

socket.on('guangxiChoice', ({ properties, ownerName, ownerColor, playerName, playerColor, rent }) => {
  $('areaE').innerHTML = `${coloredName(playerName, playerColor)}交路费${rent}，请选择地产与${coloredName(ownerName, ownerColor)}交换广西`;
  document.getElementById('areaF').innerHTML = '';
  const propertyIds = properties.map(p => p.id);
  document.querySelectorAll('.space').forEach(el => {
    const spaceId = parseInt(el.dataset.id);
    if (propertyIds.includes(spaceId)) {
      el.classList.add('highlighted');
      el.style.cursor = 'pointer';
      el.style.border = '2px solid #fff';
      el.style.boxShadow = '0 0 8px #fff';
      el.onclick = () => {
        document.querySelectorAll('.space').forEach(s => { s.classList.remove('highlighted'); s.style.cursor = ''; s.style.border = ''; s.style.boxShadow = ''; s.onclick = null; });
        socket.emit('guangxiExchange', spaceId);
      };
    }
  });
});



function showPropertyOverlay(space, spaceEl) {
  hidePropertyOverlay();
  const game = document.getElementById('game');
  const s2Area = document.getElementById('s2Area');
  const bottomBar = document.getElementById('bottomBar');
  if (!game || !s2Area || !bottomBar) return;
  const tip = document.createElement('div');
  tip.id = 'propertyOverlay';
  const s2Rect = s2Area.getBoundingClientRect();
  const bbRect = bottomBar.getBoundingClientRect();
  const gameRect = game.getBoundingClientRect();
  const topOffset = s2Rect.top - gameRect.top;
  const totalHeight = bbRect.bottom - s2Rect.top;
  tip.style.cssText = `position:absolute;top:${topOffset}px;left:0;right:0;height:${totalHeight}px;z-index:50;display:flex;align-items:center;gap:8px;background:#000;color:#fff;padding:4px 8px;overflow:hidden;font-size:16px;word-break:break-word;pointer-events:auto;`;
  const imgSrc = getSpaceImageSrc(space.name);
  let imgHtml = `<img src="${imgSrc}" style="width:calc(100vw / 3);height:auto;max-height:90%;object-fit:contain;flex-shrink:0;border-radius:4px;">`;
  let infoText = '';
  if (space.isProperty === true) {
    const propertyInfo = propertyData.find(p => p[0] === space.name);
    let rentFee = 0;
    if (propertyInfo) {
      const level = space.houseLevel || 0;
      rentFee = propertyInfo[1][level + 1];
      rentFee += (space.rentBonus || 0);
      if (rentFee < 0) rentFee = 0;
    } else if (space.price > 0) {
      rentFee = space.rent || space.price;
    }
    infoText += `${space.name}：地价${space.price} 路费${rentFee}`;
  }
  if (space.closed) {
    infoText += (infoText ? '<br>' : '') + '该地产已停业，地主经过时恢复';
  }
  let specialText = specialTextMap[space.name];
  if (space.type === 'gaitu' && space.name !== '改土' && (!specialText || specialText.length === 0)) {
    const gaitu = gaituTypes.find(g => g.name === space.name);
    if (gaitu) specialText = [gaitu.desc];
  }
  if (space.name === '机场' && space.displayName && space.displayName !== '机场') {
    const planeDescs = {
      '轰炸机': '地主到此获得炸弹卡',
      '度假机': '判1-2飞往海南，3-4休息1回合',
      '观光机': '随机弹飞',
      '客机': '地主到此飞往任1格',
      '间谍机': '地主到此掷后暗置并声明用某点数,他人可质疑：真,质疑者给你6;假反之。无人质疑：地主+9'
    };
    specialText = ['', planeDescs[space.displayName] || ''];
  }
  if (specialText && specialText.length > 0) {
    specialText.forEach(line => {
      if (line) infoText += (infoText ? '<br>' : '') + line;
    });
  }
  tip.innerHTML = imgHtml + `<div style="flex:1;min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;line-height:1.2;font-size:16px;">${infoText}</div>`;
  tip.onclick = (e) => {
    e.stopPropagation();
    tip.remove();
  };
  game.appendChild(tip);
}

function hidePropertyOverlay() {
  const overlay = document.getElementById('propertyOverlay');
  if (overlay) overlay.remove();
}

socket.on('canBuy', ({ space, dice }) => {
  // rollBtn removed
  
  // 隐藏现有actionArea
  const actionArea = $('actionArea');
  if (actionArea) actionArea.classList.add('hidden');
  
  // 不再自动显示临时图片（根据要求）
  
  // 更新E区：是否$地价购买地名？
  const areaE = $('areaE');
  if (areaE) {
    areaE.textContent = `是否$${space.price}购买${space.name}？`;
    fitAreaEText();
  }
  
  // 更新F区："购买"和"放弃"按钮
  const areaF = $('areaF');
  areaF.innerHTML = `
    <button id="confirmBuyBtn" class="jail-btn">购买</button>
    <button id="cancelBuyBtn" class="jail-btn">结束</button>
  `;
  
  const confirmBtn = $('confirmBuyBtn');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      hidePropertyOverlay();
      $('confirmBuyBtn').remove();
      socket.emit('buyProperty', { propertyId: space.id });
    };
  }
  
  const cancelBtn = $('cancelBuyBtn');
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      hidePropertyOverlay();
      $('areaE').textContent = '';
      doEndTurn();
    };
  }
});

socket.on('gameEnded', () => {
  const winner = players.filter(p => !p.bankrupt).sort((a, b) => b.money - a.money)[0];
  alert(`🏆 游戏结束！${winner?.name} 获胜！`);
  location.reload();
});

socket.on('restart', () => {
  socket.emit('inLobby');
  localStorage.removeItem('monopoly_player_name');
  localStorage.removeItem('monopoly_player_character');
  localStorage.removeItem('monopoly_player_variant');
  localStorage.removeItem('monopoly_has_joined');
  players = [];
  selectedCharacters = {};
  isJailMap = false;
  jailMinimized = false;
  fixedCwq = null;
  hasJoined = false;
  selectedChar = null;
  awaitingGoToJail = false;
  diamondCirclePlayerId = null;
  diamondCirclePlayerColor = null;
  diamondCircleProgress = 0;
  kunlunPlayerId = null;
  kunlunPlayerColor = null;
  kunlunProgress = 0;
  window.dayunState = null;
  selectingDayunPlace = false;
  const gameOverPanel = document.getElementById('gameOverPanel');
  if (gameOverPanel) gameOverPanel.remove();
  $('lobby').classList.remove('hidden');
  $('game').classList.add('hidden');
  if (settingsWrapper) settingsWrapper.classList.add('hidden');
  $('playerList').innerHTML = '';
  $('areaE').textContent = '';
  startBtn.disabled = true;
  resetDice();
  document.querySelectorAll('.char-box').forEach(b => {
    b.classList.remove('selected', 'taken');
    b.style.pointerEvents = 'auto';
  });
  const jp = document.querySelector('.jail-panel');
  if (jp) jp.remove();
});

let pendingMoneyIndicators = [];

socket.on('moneyChangePreview', ({ playerId, amount }) => {
  const indicator = { playerId, amount, timestamp: Date.now() };
  pendingMoneyIndicators.push(indicator);
  setTimeout(() => {
    pendingMoneyIndicators = pendingMoneyIndicators.filter(i => i !== indicator);
  }, 5000);
  showMoneyIndicator(playerId, amount);
});

function showMoneyIndicator(playerId, amount) {
  const card = document.querySelector(`.player-card[data-card="${playerId}"]`);
  if (!card) return;
  const moneyEl = card.querySelector('.p-money');
  if (!moneyEl) return;
  const existing = card.querySelector('.money-change-indicator');
  if (existing) existing.remove();
  const prefix = amount > 0 ? '+' : '';
  const color = '#f1c40f';
  const indicator = document.createElement('span');
  indicator.className = 'money-change-indicator';
  indicator.style.cssText = `color:${color};font-weight:bold;font-size:clamp(12px,3vw,20px);margin-left:4px;white-space:nowrap;`;
  indicator.textContent = `${prefix}${amount}`;
  moneyEl.parentNode.style.display = 'flex';
  moneyEl.parentNode.style.alignItems = 'center';
  moneyEl.parentNode.style.justifyContent = 'center';
  moneyEl.style.display = 'inline';
  moneyEl.parentNode.insertBefore(indicator, moneyEl.nextSibling);
  setTimeout(() => indicator.remove(), 5000);
}

function restoreMoneyIndicators() {
  const now = Date.now();
  pendingMoneyIndicators = pendingMoneyIndicators.filter(i => now - i.timestamp < 5000);
  pendingMoneyIndicators.forEach(i => showMoneyIndicator(i.playerId, i.amount));
}

function animateMovePlayer(playerId, fromPos, toPos, callback) {
  const player = players.find(p => p.id === playerId);
  if (!player) { if (callback) callback(); return; }
  const totalSpaces = board.length;
  const forwardDist = (toPos - fromPos + totalSpaces) % totalSpaces;
  const backwardDist = (fromPos - toPos + totalSpaces) % totalSpaces;
  if (forwardDist === 0 && backwardDist === 0) { if (callback) callback(); return; }
  const actualStep = forwardDist <= backwardDist ? 1 : -1;
  const distance = forwardDist <= backwardDist ? forwardDist : backwardDist;
  let currentPos = fromPos;
  let stepsRemaining = distance;
  function moveStep() {
    if (stepsRemaining <= 0) {
      animatingPositions.delete(playerId);
      renderBoardOnly();
      if (callback) callback();
      return;
    }
    currentPos = (currentPos + actualStep + totalSpaces) % totalSpaces;
    animatingPositions.set(playerId, currentPos);
    renderBoardOnly();
    stepsRemaining--;
    setTimeout(moveStep, 200);
  }
  moveStep();
}

socket.on('diceResult', ({ playerId, fromPos, dice, newPos, direction, teleport }) => {
  const player = players.find(p => p.id === playerId);
  if (!player) return;
  if (teleport) {
    player.position = newPos;
    renderBoardOnly();
    if (playerId === myId) socket.emit('diceAnimDone');
    return;
  }
  diceAnimating = true;
  diceAnimPlayerId = playerId;
  const stepDelay = dice > 6 ? 150 : 250;
  const isMyAnim = playerId === myId;
  const isBackward = direction === 'backward';
  let step = 0;
  function animateStep() {
    const player = players.find(p => p.id === playerId);
    if (!player) { diceAnimating = false; diceAnimPlayerId = null; return; }
    if (step >= dice) {
      player.position = newPos;
      renderBoardOnly();
      diceAnimating = false;
      diceAnimPlayerId = null;
      if (isMyAnim) socket.emit('diceAnimDone');
      return;
    }
    let nextPos;
    if (isBackward) {
      nextPos = (fromPos - step - 1 + 36) % 36;
    } else {
      nextPos = (fromPos + step + 1) % 36;
    }
    player.position = nextPos;
    renderBoardOnly();
    step++;
    setTimeout(animateStep, stepDelay);
  }
  animateStep();
});

socket.on('cicadaMove', ({ playerId, fromPos, dice, toPos, count }) => {
  cicadaActive = true;
  cicadaCount = count;
  cicadaReady = count >= 3;
  cicadaAnimating = true;
  const stepDelay = 250;
  let step = 0;
  function animateStep() {
    if (step >= dice) {
      cicadaPosition = toPos;
      cicadaAnimating = false;
      renderBoardOnly();
      socket.emit('cicadaAnimDone');
      return;
    }
    cicadaPosition = (fromPos + step + 1) % 36;
    renderBoardOnly();
    step++;
    setTimeout(animateStep, stepDelay);
  }
  animateStep();
});

socket.on('cicadaPlayerMove', ({ playerId, fromPos, toPos }) => {
  const player = players.find(p => p.id === playerId);
  if (!player) return;
  const totalSpaces = board.length;
  const forwardDist = (toPos - fromPos + totalSpaces) % totalSpaces;
  const backwardDist = (fromPos - toPos + totalSpaces) % totalSpaces;
  const distance = forwardDist <= backwardDist ? forwardDist : backwardDist;
  const actualStep = forwardDist <= backwardDist ? 1 : -1;
  let currentPos = fromPos;
  let stepsRemaining = distance;
  function moveStep() {
    if (stepsRemaining <= 0) {
      player.position = toPos;
      cicadaPosition = null;
      cicadaActive = false;
      cicadaReady = false;
      renderBoardOnly();
      socket.emit('playerMoveDone');
      return;
    }
    currentPos = (currentPos + actualStep + totalSpaces) % totalSpaces;
    player.position = currentPos;
    renderBoardOnly();
    stepsRemaining--;
    setTimeout(moveStep, 200);
  }
  moveStep();
});

socket.on('cicadaReset', () => {
  cicadaActive = false;
  cicadaCount = 0;
  cicadaPosition = null;
  cicadaAnimating = false;
  cicadaReady = false;
  cicadaCooldown = false;
  renderBoardOnly();
});

socket.on('cicadaActivated', ({ playerId }) => {
  if (playerId !== myId) return;
  cicadaActive = true;
  cicadaCount = 0;
  cicadaCooldown = true;
  ensureGAreaExists();
  showCicadaGArea();
  const p = document.getElementById('cardPackPanel');
  if (p) { p.remove(); showCardPackPanel(); }
});

function showCicadaGArea() {
  const areaG = $('areaG');
  if (areaG) {
    areaG.innerHTML = `<img src="/drawable/chongwu/chongwu2/cw0.png">`;
    areaG.style.cursor = 'pointer';
    areaG.style.opacity = '1';
    areaG.onclick = () => {
      if (!dicePickerVisible) rollRandomDice();
    };
  }
}

socket.on('cicadaTurnStart', () => {
  showCicadaGArea();
});

socket.on('cicadaSkillReady', () => {
  cicadaCooldown = false;
});

// 美猴王事件处理
socket.on('meihouwangSummoned', ({ playerId, position, remainingTurns }) => {
  window.houwangPosition = position;
  window.houwangRemainingTurns = remainingTurns;
  renderBoardOnly();
});

socket.on('meihouwangMove', ({ playerId, playerFromPos, playerDice, playerToPos, houwangFromPos, houwangDice, houwangToPos }) => {
  // 更新猴王位置
  window.houwangPosition = houwangToPos;
  renderBoardOnly();
});

socket.on('meihouwangChoiceInF', ({ playerPosition, playerSpaceName, houwangPosition, houwangSpaceName }) => {
  const areaF = document.getElementById('areaF');
  if (!areaF) return;

  areaF.innerHTML = `
    <button id="meihouwangPlayerBtn" class="jail-btn">${playerSpaceName}</button>
    <button id="meihouwangHouwangBtn" class="jail-btn">${houwangSpaceName}</button>
  `;

  document.getElementById('meihouwangPlayerBtn').onclick = () => {
    socket.emit('meihouwangSelect', { choice: 'player' });
  };

  document.getElementById('meihouwangHouwangBtn').onclick = () => {
    socket.emit('meihouwangSelect', { choice: 'houwang' });
  };
});

socket.on('meihouwangDisappear', ({ playerId }) => {
  window.houwangPosition = null;
  window.houwangRemainingTurns = null;
  renderBoardOnly();
});

socket.on('clearAreaF', () => {
  document.getElementById('areaF').innerHTML = '';
});

socket.on('wolfOverlay', ({ ownerName, ownerColor, payerId }) => {
  showBottomBarOverlay('/drawable/chongwu/3.png');
});

socket.on('wolfOverlayClose', () => {
  hideBottomBarOverlay();
});

socket.on('wolfChoice', ({ ownerName, ownerColor }) => {
  showTck('/drawable/chongwu/3.png', `${coloredName(ownerName, ownerColor)}的恶狼在咆哮！`, [
    { label: '给4', callback: () => { socket.emit('wolfChoiceResponse', 'pay4'); } },
    { label: `下次到${coloredName(ownerName, ownerColor)}的地产给10`, callback: () => { socket.emit('wolfChoiceResponse', 'mark10'); } }
  ]);
});

socket.on('chuansongMove', ({ playerId, fromPos, toPos, spaceName, senderId }) => {
  const player = players.find(p => p.id === playerId);
  const sender = players.find(p => p.id === senderId);
  if (!player || !sender) return;
  const areaE = document.getElementById('areaE');
  if (areaE) {
    areaE.innerHTML = `${coloredName(sender.name, sender.color)}使用传送卡令${coloredName(player.name, player.color)}到${spaceName}`;
    fitAreaEText();
  }
  if (senderId === myId) socket.emit('showEndTurn');
});

socket.on('taishanBackward', ({ playerId, fromPos, toPos }) => {
  animateMovePlayer(playerId, fromPos, toPos);
});

socket.on('sync', ({ players: p, board: b, gameState: gs, currentPlayerIndex: currentPlayerIndex, selectedCharacters: sel, currentDiceValue: serverDiceValue, roundCounter, kunlunState: ks, dayunState: ds, zhadanState: zs, bingdongProcessing }) => {
  window.syncData = { players: p, board: b, currentPlayerIndex, selectedCharacters: sel };
  window.boardData = b;
  const oldMoneyMap = {};
  players.forEach(pl => { oldMoneyMap[pl.id] = pl.money; });

  if (bingdongProcessing) {
    window.bingdongProcessingFlag = true;
  }

  const myPlayer = p.find(pl => pl.id === myId);
  if (myPlayer && !myPlayer.bankrupt && currentPlayerIndex === p.findIndex(pl => pl.id === myId)) {
    hasRolledThisTurn = false;
  }

  if (ks) {
    kunlunPlayerId = ks.playerId;
    kunlunPlayerColor = ks.playerColor;
    kunlunProgress = ks.progress;
  }
  if (ds !== undefined) {
    window.dayunState = ds;
  }
  if (zs !== undefined) {
    window.zhadanState = zs;
  }
  if (zs === null) {
    window.zhadanState = null;
  }
  let savedPos = null;
  if (diceAnimating && diceAnimPlayerId) {
    const ap = players.find(pl => pl.id === diceAnimPlayerId);
    if (ap) savedPos = ap.position;
  }
  const prevPlayerIdx = currentPlayerIdx;
  const prevMe = players.find(x => x.id === myId);
  const wasPetFlipped = prevMe?.petFlipped;
  players = p; board = b; currentPlayerIdx = currentPlayerIndex;
  if (prevPlayerIdx !== currentPlayerIdx) {
    showThinkingOnce = true;
    lastAreaEMessage = '';
  }
  const meAfter = players.find(x => x.id === myId);
  if (meAfter && wasPetFlipped === true && meAfter.petFlipped === false) {
    activePetUsedThisTurn = false;
  }
  if (savedPos !== null) {
    const ap = players.find(pl => pl.id === diceAnimPlayerId);
    if (ap) ap.position = savedPos;
  }
  selectedCharacters = sel || {};
  if (serverDiceValue !== undefined) {
    currentDiceValue = serverDiceValue;
  }
  if (currentDiceValue === 0) {
    wenjigifwuDiceValues = null;
    liebaoDiceValues = null;
  }
  const roundDisplay = $('roundDisplay');
  if (roundDisplay && roundCounter !== undefined) {
    const cur = players[currentPlayerIdx];
    roundDisplay.textContent = `第${roundCounter}轮 `;
    roundDisplay.style.color = '#888';
    const header = roundDisplay.closest('header');
    if (header) header.style.background = '';
  }
  const mePlayer = p.find(x => x.id === myId);
  if (mePlayer && mePlayer.restTurns > 0 && currentPlayerIndex === p.indexOf(mePlayer)) {
    const areaG = $('areaG');
    if (areaG) {
      areaG.innerHTML = '';
      areaG.style.cursor = 'default';
      areaG.onclick = null;
    }
  }
  if (sel) document.querySelectorAll('.char-box').forEach(box => { if (sel[box.dataset.char]) box.classList.add('taken'); });
  const playerList = $('playerList');
  if (playerList && p.length) {
    playerList.innerHTML = p.map(x =>
      `<div class="p-item" style="position:relative;"><div class="dot" style="background:${x.color}"></div><img src="/drawable/juese/${x.character}${x.variant || '2'}.png" style="width:24px;height:24px;"><span style="color:#fff;">${x.name}</span><span class="remove-player-btn" data-player-id="${x.id}" style="position:absolute;top:-6px;right:-6px;width:16px;height:16px;background:#e94560;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:10px;line-height:1;">×</span></div>`
    ).join('');
    playerList.querySelectorAll('.remove-player-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const pid = btn.dataset.playerId;
        if (pid) socket.emit('removePlayer', { playerId: pid });
      };
    });
  }
  if (startBtn) startBtn.disabled = p.length < 1;
  if (gs === 'playing') {
    $('lobby').classList.add('hidden');
    $('game').classList.remove('hidden');
    if (settingsWrapper) settingsWrapper.classList.remove('hidden');
    emojiBtn.classList.remove('hidden');
    if (testDiceBtn) testDiceBtn.classList.add('hidden');
    $('disconnectBtn2')?.classList.remove('hidden');
    if (screen.orientation?.lock) screen.orientation.lock('landscape').catch(() => {});
  }
  let me = players.find(p => p.id === myId);
  if (!me) {
    const savedName = localStorage.getItem('monopoly_player_name');
    const savedCharacter = localStorage.getItem('monopoly_player_character');
    me = players.find(p => p.name === savedName && (p.character + (p.variant || '')) === savedCharacter);
    if (me) {
      myId = me.id;
    }
  }
  if (!me) {
    const myChar = Object.keys(selectedCharacters).find(k => selectedCharacters[k] === socket.id);
    if (myChar) {
      const myPlayer = players.find(p => p.character === myChar);
      if (myPlayer) {
        myId = myPlayer.id;
        me = myPlayer;
      }
    }
  }
  if (gs === 'playing') {
    renderBoardOnly();
    refreshPlayerCards();
    adjustPlayerNameFontSize();
    restoreMoneyIndicators();
    render();
    players.forEach(pl => {
      const oldMoney = oldMoneyMap[pl.id];
      if (oldMoney !== undefined && pl.money !== oldMoney) {
        const diff = pl.money - oldMoney;
        const alreadyShown = pendingMoneyIndicators.some(i => i.playerId === pl.id && i.amount === diff && (Date.now() - i.timestamp) < 1000);
        if (!alreadyShown) {
          const indicator = { playerId: pl.id, amount: diff, timestamp: Date.now() };
          pendingMoneyIndicators.push(indicator);
          setTimeout(() => { pendingMoneyIndicators = pendingMoneyIndicators.filter(i => i !== indicator); }, 5000);
          showMoneyIndicator(pl.id, diff);
        }
      }
    });
    const mePlayer = players.find(p => p.id === myId);
  }
  if (window._pendingYingmoJailShow) {
    window._pendingYingmoJailShow = false;
    showJailPanel();
  }
  const cur = players[currentPlayerIdx];
  const isMyTurn = cur?.id === myId && !cur?.bankrupt;
  if (cur?.inJail) {
    ensureGAreaExists();
    const areaG = $('areaG');
    if (areaG) {
      areaG.innerHTML = '';
      areaG.style.cursor = 'default';
      areaG.onclick = null;
    }
  } else if (cur?.bingdong > 0 || cur?.jinzuStayTurn || window.bingdongProcessingFlag) {
    ensureGAreaExists();
    const areaG = $('areaG');
    if (areaG) {
      areaG.innerHTML = '';
      areaG.style.cursor = 'default';
      areaG.onclick = null;
    }
  } else {
    ensureGAreaExists();
    updateGAreaDiceImage(currentDiceValue, isMyTurn);
  }
  // 不在sync中操作tckQueue/tckOverlay，避免与kunlunResult冲突
  // tckQueue的清理由kunlunResult等事件负责
  if (pendingLoadRender) {
    pendingLoadRender = false;
    renderBoardOnly();
  }
});

document.addEventListener('click', (e) => {
  const card = e.target.closest('.player-card.can-rejoin');
  if (card) {
    const playerName = card.dataset.name;
    const fullChar = card.dataset.character;
    const colorMatch = fullChar.match(/^(hong|cheng|huang|haung|lv|lan|zi)(\d*)$/);
    const charColor = colorMatch ? colorMatch[1] : fullChar;
    const charVariant = colorMatch ? colorMatch[2] : '';
    localStorage.setItem('monopoly_player_name', playerName);
    localStorage.setItem('monopoly_player_character', fullChar);
    localStorage.setItem('monopoly_player_variant', charVariant);
    socket.emit('join', { name: playerName, character: charColor, variant: charVariant });
  }
  if (e.target.classList.contains('me-label')) {
    showEmojiPanel();
  }
});

socket.on('rejoinSuccess', ({ playerId }) => {
  myId = playerId;
  hasJoined = true;
  localStorage.setItem('monopoly_has_joined', 'true');
  $('gameContainer')?.classList.remove('hidden');
  $('actionBar')?.classList.remove('hidden');
  $('bottomBar')?.classList.remove('hidden');
  const modal = document.getElementById('reconnectModal');
  if (modal) {
    modal.remove();
  }
  // 只恢复棋盘和玩家卡片，不调用完整render()以避免清空F区
  renderBoardOnly();
  restoreMoneyIndicators();
  refreshPlayerCards();
  // 服务端会发送相应的面板和F区状态事件
});

socket.on('reconnectSuccess', ({ playerId, playerName }) => {
  myId = playerId;
  hasJoined = true;
  localStorage.setItem('monopoly_has_joined', 'true');
  localStorage.setItem('monopoly_player_name', playerName);
  render();
});

socket.on('joinRejected', ({ reason }) => {
  // 清除localStorage，避免反复尝试加入
  localStorage.removeItem('monopoly_player_name');
  localStorage.removeItem('monopoly_player_character');
  localStorage.removeItem('monopoly_player_variant');
  localStorage.removeItem('monopoly_has_joined');
  hasJoined = false;
});

socket.on('playerRemoved', () => {
  localStorage.removeItem('monopoly_player_name');
  localStorage.removeItem('monopoly_player_character');
  localStorage.removeItem('monopoly_player_variant');
  localStorage.removeItem('monopoly_has_joined');
  hasJoined = false;
  selectedChar = null;
  selectedVariant = null;
  document.querySelectorAll('.char-box').forEach(b => b.classList.remove('selected'));
});


// 钻石图标Tooltip显示
function showDiamondTooltip(e) {
  e.stopPropagation();
  const tooltipContent = e.currentTarget.dataset.tooltip;
  const imgSrc = e.currentTarget.tagName === 'IMG' ? e.currentTarget.src : null;
  let html = '';
  if (imgSrc) {
    html += `<img src="${imgSrc}" style="width:clamp(80px,20vw,130px);height:clamp(80px,20vw,130px);object-fit:contain;flex-shrink:0;">`;
  }
  if (tooltipContent) {
    let processed = tooltipContent.replace(/\\n/g, '<br>').replace(/\n/g, '<br>');
    html += `<span>${processed}</span>`;
  } else {
    html += `<span>钻石</span>`;
  }
  showPopupMessage(html);
}

function hideDiamondTooltip() {
}

function renderPlayerCards() {
  const cur = players[currentPlayerIdx];
  const isSelectingTarget = selectingHezongTarget || sansiSelectingTarget || selectingSwapTarget || selectingRouletteTarget || selectingStartTarget || selectingIslandSwapTarget || selectingJidiTarget || selectingGaichaoTarget || selectingBaijinTarget || selectingNongminTarget || selectingQiyuTarget || selectingGuashaTarget || selectingJiaoyiTarget || selectingZemuerqiTarget || jiaoyiSelectingProp || qiutuSelectingPlayers || selectingQiangjieTarget || selectingPinqianTarget || selectingTexasPlayer || selectingLongjuanfengTarget || selectingTingyeTarget || selectingBingdongTarget || selectingHeikeTarget || selectingJinghuaTarget || selectingShuimianTarget || qiyuAnmianyaoSelecting || qiyuFengdiSelecting || qiyuBaguanSelecting || qiyuBafangQianniuSelecting || qiyuZaizangSelecting || qiyuNilaiWangwangSelecting || qiyuMeirenjiSelecting || qiyuGuhuoSelecting || qiyuGanjinJuejueSelecting || qiyuHunanganshiSelecting || zangkuanSelectingTarget || qiyuLianyinSelectingTarget || qiyuBomingSelecting || qiyuJinzuSelecting || qiyuLiufangSelecting || qiyuJiebanWanleSelecting || qiyuTuoleiSelecting || qiyuFuwufeiSelecting || qiyuTudijianbingSelectingTarget || qiyuXiaolicangdaoSelectingTarget || qiyuXiaduSelectingTarget || qiyuJietouDouruSelectingTarget || qiyuAnduchengcangSelectingTarget || qiyuQiankundanayiSelectingTarget || hunshuiSelectingTarget || lianheSelectingTarget || erenSelectingTarget || diaohuSelectingTarget || selectingPaozhuanTarget || selectingYuanjiaoTargetA || selectingYuanjiaoTargetB || selectingXianhaiTarget || window.selectingXitieshiTarget || window.selectingLijianTarget || fengkongSelectingTarget || daoyingSelectingTarget || selectingLunciTarget || selectingJiandieTarget || window.hezuorenwuSelectingTarget || window.meihuoSelectingTarget || selectingChuansongPlayerTarget || selectingFengdiCardTarget || selectingYingmoTarget;
  return players.map(p => {
    const isMe = p.id === myId;
    const isCanRejoin = p.offline;
    const nameDisplay = p.name.length > 4 ? p.name.substring(0, 4) : p.name;
    const isActiveTurn = p.id === cur?.id && !isSelectingTarget;
    const isTargetable = isSelectingTarget && !p.bankrupt && (selectingLongjuanfengTarget || selectingBingdongTarget || selectingJinghuaTarget || qiyuBaguanSelecting || sansiSelectingTarget || selectingTingyeTarget || selectingShuimianTarget || selectingYingmoTarget || !p.sheltered) && (selectingHezongTarget || selectingRouletteTarget || selectingJidiTarget || qiutuSelectingPlayers || selectingLongjuanfengTarget || selectingBingdongTarget || selectingHeikeTarget || selectingJinghuaTarget || selectingShuimianTarget || qiyuBaguanSelecting || qiyuNilaiWangwangSelecting || qiyuBomingSelecting || qiyuJinzuSelecting || qiyuLiufangSelecting || qiyuJiebanWanleSelecting || qiyuTuoleiSelecting || qiyuFuwufeiSelecting || qiyuTudijianbingSelectingTarget || qiyuHunanganshiSelecting || window.selectingLijianTarget || zangkuanSelectingTarget || fengkongSelectingTarget || daoyingSelectingTarget || selectingTexasPlayer || selectingTingyeTarget || selectingChuansongPlayerTarget || selectingFengdiCardTarget || selectingYingmoTarget || p.id !== myId) && !(selectingRouletteTarget && rouletteExcludedIds.includes(p.id)) && !(selectingStartTarget && !startTargetIds.includes(p.id)) && !(selectingIslandSwapTarget && !islandSwapBidsData.find(b => b.playerId === p.id)) && !(selectingJidiTarget && (p.id === myId || !jidiAliveIds.includes(p.id))) && !(selectingGaichaoTarget && p.id === myId) && !(selectingBaijinTarget && p.id === myId) && !(selectingNongminTarget && p.id === myId) && !(selectingNongminTarget && !board.some(s => s.isProperty && s.owner === p.id)) && !(selectingQiyuTarget && p.id === myId) && !(selectingGuashaTarget && (p.id === myId || p.money <= 50)) && !(selectingJiaoyiTarget && (p.id === myId || !board.some(s => s.isProperty && s.owner === p.id))) && !(selectingZemuerqiTarget && (p.id === myId || !p.petImage)) && !(selectingQiangjieTarget && p.id === myId) && !(selectingPinqianTarget && p.id === myId) && !(selectingTingyeTarget && !tingyeCanSelectSelf && p.id === myId) && !(selectingLongjuanfengTarget && !longjuanfengCanSelectSelf && p.id === myId) && !(selectingBingdongTarget && !bingdongCanSelectSelf && p.id === myId) && !(selectingBingdongTarget && p.sheltered && p.id !== myId) && !(selectingHeikeTarget && (p.id === myId || !p.frozen || p.frozen <= 0)) && !(qiyuGuhuoSelecting && p.id === myId) && !(qiyuMeirenjiSelecting && p.id === myId) && !(qiyuGanjinJuejueSelecting && p.id === myId) && !(zangkuanSelectingTarget && p.id === myId) && !(qiyuLianyinSelectingTarget && p.id === myId) && !(qiyuBomingSelecting && p.id === myId) && !(qiyuJinzuSelecting && p.id === myId) && !(qiyuLiufangSelecting && p.id === myId) && !(qiyuJiebanWanleSelecting && p.id === myId) && !(qiyuTuoleiSelecting && p.id === myId) && !(qiyuFuwufeiSelecting && p.id === myId) && !(qiyuTudijianbingSelectingTarget && (p.id === myId || !board.some(s => s.isProperty && s.owner === p.id))) && !(qiyuXiaolicangdaoSelectingTarget && p.id === myId) && !(qiyuXiaduSelectingTarget && (p.id === myId || !p.petImage)) && !(qiyuJietouDouruSelectingTarget && p.id === myId) && !(qiyuAnduchengcangSelectingTarget && (p.id === myId || !window.qiyuAnduchengcangTargets?.some(t => t.id === p.id))) && !(qiyuQiankundanayiSelectingTarget && p.id === myId) && !(window.hezuorenwuSelectingTarget && (p.id === myId || !window.hezuorenwuTargets?.some(t => t.id === p.id))) && !(window.meihuoSelectingTarget && (p.id === myId || !window.meihuoTargets?.some(t => t.id === p.id))) && !(hunshuiSelectingTarget && (p.id === myId || !p.cards || p.cards.length === 0)) && !(lianheSelectingTarget && p.id === myId) && !(erenSelectingTarget && p.id === myId) && !(diaohuSelectingTarget && p.id === myId) && !(selectingPaozhuanTarget && (p.id === myId || !board.some(s => s.isProperty && s.owner === p.id))) && !(selectingYuanjiaoTargetA && p.id === myId) && !(selectingYuanjiaoTargetB && (p.id === myId || p.id === yuanjiaoTargetAId)) && !(selectingXianhaiTarget && p.id === myId) && !(selectingShuimianTarget && !shuimianCanSelf && p.id === myId) && !(window.selectingXitieshiTarget && p.id === myId) && !(window.selectingLijianTarget && window.lijianFirstTarget && p.id === window.lijianFirstTarget) && !(qiyuMeirenjiSelecting && qiyuMeirenjiFirstTarget && p.id === qiyuMeirenjiFirstTarget) && !(qiyuNilaiWangwangSelecting && qiyuNilaiWangwangFirstTarget && p.id === qiyuNilaiWangwangFirstTarget) && !(qiyuNilaiWangwangSelecting && !board.some(s => s.isProperty && s.owner === p.id)) && !(fengkongSelectingTarget && p.id === myId) && !(daoyingSelectingTarget && p.id === myId) && !(selectingLunciTarget && p.id === myId) && !(selectingJiandieTarget && (p.id === myId || p.sheltered)) && !(selectingJiandieTarget && jiandieSelectedFirst && p.id === jiandieSelectedFirst) && !(selectingChuansongPlayerTarget && !chuansongCanSelectSelf && p.id === myId) && !(selectingFengdiCardTarget && !fengdiCardCanSelectSelf && p.id === myId);

    const isExtraTurn = extraTurnPlayerId === p.id;
    const bankruptStyle = p.bankrupt ? 'opacity:0.4;filter:grayscale(1);' : '';
    let borderStyle = '';
    if (isTargetable) {
      borderStyle = 'border:2px solid #fff;cursor:pointer;';
    } else if (isExtraTurn || isActiveTurn) {
      borderStyle = `border:2px solid ${p.color};`;
    }
    const m1m2BorderStyle = '';
    const playerCardBorderStyle = borderStyle;
    const m3Icons = (() => {
      const icons = [];
      if (p.inJail) icons.push(`<span class="m3-status-icon jail-m3-icon" data-player-id="${p.id}" style="cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;"><svg viewBox="0 0 16 16" width="16" height="16"><line x1="2" y1="8" x2="14" y2="8" stroke="#fff" stroke-width="2"/><line x1="5" y1="2" x2="5" y2="14" stroke="#fff" stroke-width="1.8"/><line x1="8" y1="2" x2="8" y2="14" stroke="#fff" stroke-width="1.8"/><line x1="11" y1="2" x2="11" y2="14" stroke="#fff" stroke-width="1.8"/></svg></span>`);
      if (p.extraTurns > 0) icons.push(`<span class="m3-status-icon extra-turn-badge" data-tooltip="再动${p.extraTurns}次">🔂</span>`);
      if (p.fuwufeiExtraMove) icons.push(`<span class="m3-status-icon extra-turn-badge" data-tooltip="再动1次">🔂</span>`);
      if (p.restTurns > 0) icons.push(`<span class="m3-status-icon rest-badge" data-rest-turns="${p.restTurns}" data-tooltip="休息${p.restTurns}回合">💤</span>`);
      if (p.sheltered) icons.push(`<img src="/drawable/zhuangtai/binan.png" class="m3-status-icon" data-tooltip="无法成为他人目标${p.shelteredTurns || 0}回合">`);
      if (p.shihua) icons.push(`<img src="/drawable/zhuangtai/shihua.png" class="m3-status-icon" data-tooltip="石化，不能移动直到判5-6">`);
      if (p.guhuoDice) {
        icons.push(`<img src="/drawable/zhuangtai/touzi.png" class="m3-status-icon" data-tooltip="被${p.guhuoBy || '他人'}蛊惑点数${p.guhuoDice}">`);
      }
      if (p.shoumaiDice) {
        icons.push(`<img src="/drawable/zhuangtai/touzi.png" class="m3-status-icon" data-tooltip="下回合掷${p.shoumaiDice}">`);
      }
      if (p.yinyueDice) {
        icons.push(`<img src="/drawable/zhuangtai/touzi.png" class="m3-status-icon" data-tooltip="被${p.yinyueBy || '他人'}音乐指挥，下回合掷${p.yinyueDice}">`);
      }
      if (p.shijieWar) icons.push(`<span class="m3-status-icon" data-tooltip="世界大战，回合结束-10直到游戏结束">⚔️</span>`);
      if (p.hezongState === 'forced' || p.hezongState === 'normal') icons.push(`<img src="/drawable/zhuangtai/hezong.png" class="m3-status-icon" data-tooltip="停留直到2人合纵">`);
      if (p.diceEffects && p.diceEffects.length > 0) {
        p.diceEffects.forEach((eff, idx) => {
          icons.push(`<img src="/drawable/zhuangtai/touzi.png" class="m3-status-icon" data-tooltip="${eff.tooltip}">`);
        });
      }
      if (p.daotui) {
        icons.push(`<img src="/drawable/kapian/daotui.png" class="m3-status-icon" data-tooltip="倒退1回合">`);
      }
      if (p.zaie && p.zaie > 0) {
        icons.push(`<img src="/drawable/zhuangtai/zaie.png" class="m3-status-icon" data-tooltip="灾厄，持续${p.zaie}回合">`);
      }
      if (p.fengdiTurns > 0) {
        icons.push(`<img src="/drawable/kapian/fengdi.png" class="m3-status-icon" data-tooltip="不能买地/建房，持续${p.fengdiTurns}回合">`);
      }
      if (p.bingdong > 0) {
        icons.push(`<img src="/drawable/kapian/bingdong.png" class="m3-status-icon" data-tooltip="停留1回合">`);
      }
      if (p.bomingFrozen) {
        icons.push(`<span class="m3-status-icon" style="color:#fff;" data-tooltip="冻结所有钱直到${players.find(pl => pl.id === p.bomingFrozen)?.name || '某人'}回合开始">搏命</span>`);
      }
      if (p.jinzu) {
        icons.push(`<img src="/drawable/kapian/bingdong.png" class="m3-status-icon" data-tooltip="被${players.find(pl => pl.id === p.jinzu)?.name || '某人'}冰冻，下回合停留原地">`);
      }
      if (p.mammothFrozenBy) {
        const owner = players.find(pl => pl.id === p.mammothFrozenBy);
        icons.push(`<img src="/drawable/chongwu/chongwu2/cw2.png" class="m3-status-icon mammoth-frozen-icon" data-mammoth-owner="${p.mammothFrozenBy}" data-tooltip="被${owner ? owner.name : '某人'}冻住，直到判定4-6" style="cursor:pointer;">`);
      }
      if (p.mammothSelfFrozen) {
        icons.push(`<img src="/drawable/chongwu/chongwu2/cw2.png" class="m3-status-icon mammoth-frozen-icon" data-tooltip="被寒冰猛犸冻住自己，直到判定4-6" style="cursor:pointer;">`);
      }
      if (p.tuolei && p.tuolei.turns > 0) {
        icons.push(`<img src="/drawable/zhuangtai/touzi.png" class="m3-status-icon" data-tooltip="被${p.tuolei.by || '他人'}拖累，下回合掷1-2">`);
      }
      if (p.wenjigifwu) {
        icons.push(`<img src="/drawable/zhuangtai/touzi.png" class="m3-status-icon" data-tooltip="闻鸡起舞，下回合掷出骰子数+1">`);
      }
      if (p.dizhuTurns > 0) {
        icons.push(`<img src="/drawable/zhuangtai/dizhu.jpg" class="m3-status-icon" data-tooltip="获得全部地产直到下回合结束">`);
      }
      if (p.fengkongDice && p.fengkongDice.length > 0) {
        icons.push(`<img src="/drawable/zhuangtai/touzi.png" class="m3-status-icon" data-tooltip="被封控，下回合不能掷出${p.fengkongDice.join(',')}">`);
      }
      if (p.syncedDice) {
        icons.push(`<img src="/drawable/zhuangtai/touzi.png" class="m3-status-icon" data-tooltip="被${p.syncedByName || '他人'}同步，下回合掷${p.syncedDice}">`);
      }
      if (p.cunqianList && p.cunqianList.length > 0) {
        p.cunqianList.forEach(r => {
          icons.push(`<img src="/drawable/zhuangtai/cunqian.png" class="m3-status-icon" data-tooltip="${r}轮后+50">`);
        });
      }
      if (p.tempMoney && p.tempMoney > 0 && p.tempTurns > 0) {
        const circledNum = ['','①','②','③','④','⑤'][p.tempTurns] || p.tempTurns;
        icons.push(`<span class="m3-temp-money-icon" data-tooltip="可供临时使用金钱，还剩${p.tempTurns}回合" data-temp-money="${p.tempMoney}" data-temp-turns="${p.tempTurns}">${p.tempMoney}${circledNum}</span>`);
      }
      if (p.wolfMark) {
        icons.push(`<img src="/drawable/chongwu/chongwu2/cw1.png" class="m3-status-icon" data-tooltip="下次到${p.wolfMark.ownerName}的地产给10，宠物刷新时清除">`);
      }
      if (p.snailStatus) {
        icons.push(`<img src="/drawable/chongwu/7.png" class="m3-status-icon" data-tooltip="神速蜗牛：下回合只能掷小点" style="border-radius:50%;">`);
      }
      if (p.snakeReduction && p.snakeReduction > 0) {
        icons.push(`<img src="/drawable/chongwu/17.png" class="m3-status-icon" data-tooltip="点数上限-${p.snakeReduction}，失去的点数改为休息，然后点数上限+1">`);
      }
      return `<div class="card-row m3-row"><div class="m3-zone"><div class="m3-scroll">${icons.length > 0 ? icons.join('') : '<span style="font-size:1px;">​</span>'}</div></div></div>`;
    })();
    return `<div class="player-card${isActiveTurn ? ' active-turn' : ''}${p.offline ? ' offline' : ''}${isCanRejoin ? ' can-rejoin' : ''}${(() => { const savedName = localStorage.getItem('monopoly_player_name'); const isMyCard = isMe || (p.offline && p.name === savedName); return (isDisconnected || p.offline) && isMyCard ? ' disconnected' : ''; })()}" style="${playerCardBorderStyle}${bankruptStyle}" data-card="${p.id}" data-name="${p.name}" data-character="${p.character}${p.variant || ''}" ${(() => { const savedName = localStorage.getItem('monopoly_player_name'); const isMyCard = isMe || (p.offline && p.name === savedName); return (isDisconnected || p.offline) && isMyCard ? 'onclick="handleReconnect()"' : ''; })()} ${isCanRejoin ? `onclick="handleReconnect('${p.id}', '${p.name}')"` : ''} ${isTargetable && selectingHezongTarget ? `onclick="selectHezongTarget('${p.id}')"` : ''} ${isTargetable && sansiSelectingTarget ? `onclick="selectSansiTarget('${p.id}')"` : ''} ${isTargetable && selectingSwapTarget ? `onclick="selectSwapTarget('${p.id}')"` : ''} ${isTargetable && selectingRouletteTarget ? `onclick="selectRouletteTarget('${p.id}')"` : ''} ${isTargetable && selectingStartTarget ? `onclick="selectStartTarget('${p.id}')"` : ''} ${isTargetable && selectingIslandSwapTarget ? `onclick="selectIslandSwapTarget('${p.id}')"` : ''} ${isTargetable && selectingJidiTarget ? `onclick="selectJidiTarget('${p.id}')"` : ''} ${isTargetable && selectingGaichaoTarget ? `onclick="selectGaichaoTarget('${p.id}')"` : ''} ${isTargetable && selectingBaijinTarget ? `onclick="selectBaijinTarget('${p.id}')"` : ''} ${isTargetable && selectingNongminTarget ? `onclick="selectNongminTarget('${p.id}')"` : ''} ${isTargetable && selectingQiyuTarget ? `onclick="selectQiyuTarget('${p.id}')"` : ''} ${isTargetable && selectingGuashaTarget ? `onclick="selectGuashaTarget('${p.id}')"` : ''} ${isTargetable && selectingJiaoyiTarget ? `onclick="selectJiaoyiTarget('${p.id}')"` : ''} ${isTargetable && selectingZemuerqiTarget ? `onclick="selectZemuerqiTarget('${p.id}')"` : ''} ${isTargetable && qiutuSelectingPlayers ? `onclick="selectQiutuPlayer('${p.id}')"` : ''} ${isTargetable && selectingQiangjieTarget ? `onclick="selectQiangjieTarget('${p.id}')"` : ''} ${isTargetable && selectingPinqianTarget ? `onclick="selectPinqianTarget('${p.id}')"` : ''} ${isTargetable && selectingTexasPlayer ? `onclick="selectTexasTarget('${p.id}')"` : ''} ${isTargetable && selectingLongjuanfengTarget ? `onclick="selectLongjuanfengTarget('${p.id}')"` : ''} ${isTargetable && selectingTingyeTarget ? `onclick="selectTingyeTarget('${p.id}')"` : ''} ${isTargetable && selectingBingdongTarget ? `onclick="selectBingdongTarget('${p.id}')"` : ''} ${isTargetable && selectingHeikeTarget ? `onclick="selectHeikeTarget('${p.id}')"` : ''} ${isTargetable && selectingJinghuaTarget ? `onclick="selectJinghuaTarget('${p.id}')"` : ''} ${isTargetable && qiyuAnmianyaoSelecting ? `onclick="selectQiyuAnmianyaoTarget('${p.id}')"` : ''} ${isTargetable && qiyuFengdiSelecting ? `onclick="selectQiyuFengdiTarget('${p.id}')"` : ''} ${isTargetable && selectingChuansongPlayerTarget ? `onclick="selectChuansongPlayerTarget('${p.id}')"` : ''} ${isTargetable && selectingFengdiCardTarget ? `onclick="selectFengdiCardTarget('${p.id}')"` : ''} ${isTargetable && qiyuBaguanSelecting ? `onclick="selectQiyuBaguanTarget('${p.id}')"` : ''} ${isTargetable && qiyuBafangQianniuSelecting ? `onclick="selectQiyuBafangQianniuTarget('${p.id}')"` : ''} ${isTargetable && qiyuZaizangSelecting ? `onclick="selectQiyuZaizangTarget('${p.id}')"` : ''} ${isTargetable && qiyuNilaiWangwangSelecting ? `onclick="selectQiyuNilaiWangwangTarget('${p.id}')"` : ''} ${isTargetable && qiyuMeirenjiSelecting ? `onclick="selectQiyuMeirenjiTarget('${p.id}')"` : ''} ${isTargetable && qiyuGuhuoSelecting ? `onclick="selectQiyuGuhuoTarget('${p.id}')"` : ''} ${isTargetable && qiyuGanjinJuejueSelecting ? `onclick="selectQiyuGanjinJuejueTarget('${p.id}')"` : ''} ${isTargetable && qiyuHunanganshiSelecting ? `onclick="selectQiyuHunanganshiTarget('${p.id}')"` : ''} ${isTargetable && zangkuanSelectingTarget ? `onclick="selectZangkuanTarget('${p.id}')"` : ''} ${isTargetable && fengkongSelectingTarget ? `onclick="selectFengkongTarget('${p.id}')"` : ''} ${isTargetable && qiyuLianyinSelectingTarget ? `onclick="selectQiyuLianyinTarget('${p.id}')"` : ''} ${isTargetable && qiyuBomingSelecting ? `onclick="selectQiyuBomingTarget('${p.id}')"` : ''} ${isTargetable && qiyuJinzuSelecting ? `onclick="selectQiyuJinzuTarget('${p.id}')"` : ''} ${isTargetable && qiyuLiufangSelecting ? `onclick="selectQiyuLiufangTarget('${p.id}')"` : ''} ${isTargetable && qiyuJiebanWanleSelecting ? `onclick="selectQiyuJiebanWanleTarget('${p.id}')"` : ''} ${isTargetable && qiyuTuoleiSelecting ? `onclick="selectQiyuTuoleiTarget('${p.id}')"` : ''} ${isTargetable && qiyuFuwufeiSelecting ? `onclick="selectQiyuFuwufeiTarget('${p.id}')"` : ''} ${isTargetable && qiyuTudijianbingSelectingTarget ? `onclick="selectQiyuTudijianbingTarget('${p.id}')"` : ''} ${isTargetable && qiyuXiaolicangdaoSelectingTarget ? `onclick="selectQiyuXiaolicangdaoTarget('${p.id}')"` : ''} ${isTargetable && qiyuXiaduSelectingTarget ? `onclick="selectQiyuXiaduTarget('${p.id}')"` : ''} ${isTargetable && qiyuJietouDouruSelectingTarget ? `onclick="selectQiyuJietouDouruTarget('${p.id}')"` : ''} ${isTargetable && qiyuAnduchengcangSelectingTarget ? `onclick="selectQiyuAnduchengcangTarget('${p.id}')"` : ''} ${isTargetable && qiyuQiankundanayiSelectingTarget ? `onclick="selectQiyuQiankundanayiTarget('${p.id}')"` : ''} ${isTargetable && window.hezuorenwuSelectingTarget ? `onclick="selectHezuorenwuTarget('${p.id}')"` : ''} ${isTargetable && window.meihuoSelectingTarget ? `onclick="selectMeihuoTarget('${p.id}')"` : ''} ${isTargetable && hunshuiSelectingTarget ? `onclick="selectHunshuiTarget('${p.id}')"` : ''} ${isTargetable && lianheSelectingTarget ? `onclick="selectLianheTarget('${p.id}')"` : ''} ${isTargetable && erenSelectingTarget ? `onclick="selectErenTarget('${p.id}')"` : ''} ${isTargetable && diaohuSelectingTarget ? `onclick="selectDiaohuTarget('${p.id}')"` : ''} ${isTargetable && selectingPaozhuanTarget ? `onclick="selectPaozhuanTarget('${p.id}')"` : ''} ${isTargetable && selectingYuanjiaoTargetA ? `onclick="selectYuanjiaoTargetA('${p.id}')"` : ''} ${isTargetable && selectingYuanjiaoTargetB ? `onclick="selectYuanjiaoTargetB('${p.id}')"` : ''} ${isTargetable && selectingXianhaiTarget ? `onclick="selectXianhaiTarget('${p.id}')"` : ''} ${isTargetable && selectingShuimianTarget ? `onclick="selectShuimianTarget('${p.id}')"` : ''} ${isTargetable && window.selectingXitieshiTarget ? `onclick="selectXitieshiTarget('${p.id}')"` : ''} ${isTargetable && window.selectingLijianTarget ? `onclick="selectLijianTarget('${p.id}')"` : ''} ${isTargetable && daoyingSelectingTarget ? `onclick="selectDaoyingTarget('${p.id}')"` : ''} ${isTargetable && selectingLunciTarget ? `onclick="selectLunciTarget('${p.id}')"` : ''} ${isTargetable && selectingJiandieTarget ? `onclick="selectJiandieTarget('${p.id}')"` : ''} ${isTargetable && selectingYingmoTarget ? `onclick="selectYingmoTarget('${p.id}')"` : ''}>
      <div class="card-row name-row">
        <div class="m1-zone">
          <div class="char-wrapper" style="display:flex;align-items:center;justify-content:center;width:100%;gap:2px;position:relative;z-index:1;">
            <span class="role-circle-inline" style="display:inline-block;width:clamp(8px,1.25vh,12px);height:clamp(8px,1.25vh,12px);border-radius:50%;background:${p.color};flex-shrink:0;"></span>
            <span class="player-name-text" style="color:#fff;white-space:nowrap;font-weight:bold;">${nameDisplay}</span>
          </div>
        </div>
      </div>
      <div class="card-row">
        <div class="m2-zone">
          <div class="p-info">
            <div class="p-money" style="color:#fff;">${(() => { if (p.bankrupt) return `第${p.money < 0 ? -p.money : '?'}名`; if (p.offline) return '重连'; const bid = islandSwapBidsData.find(b => b.playerId === p.id); if (bid) return `报价：${bid.price}`; if (p.bomingFrozen) return `0`; return p.money; })()}</div>
          </div>
        </div>
      </div>
      ${m3Icons}
    </div>`;
  }).join('');
}

function refreshPlayerCards() {
  $('playerInfoPanel').innerHTML = renderPlayerCards();
  initDiamondTooltip();
  initCardTooltip();

  // 临时金钱图标点击事件
  document.querySelectorAll('.m3-temp-money-icon').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const tempMoney = el.dataset.tempMoney;
      const tempTurns = el.dataset.tempTurns;
      showTip('/drawable/zhuangtai/linshijinqian.jpg', `可供临时使用金钱，还剩${tempTurns}回合`);
    });
  });

  // M3监狱图标点击事件 - 使用事件委托避免刷新后丢失
  const panel = $('playerInfoPanel');
  if (panel && !panel._jailIconDelegated) {
    panel._jailIconDelegated = true;
    panel.addEventListener('click', (e) => {
      const jailIcon = e.target.closest('.jail-m3-icon');
      if (jailIcon) {
        e.stopPropagation();
        const playerId = jailIcon.dataset.playerId;
        const p = players.find(pl => pl.id === playerId);
        if (p && p.inJail) {
          showJailPanel();
        }
      }
    });
    panel.addEventListener('touchend', (e) => {
      const jailIcon = e.target.closest('.jail-m3-icon');
      if (jailIcon) {
        e.preventDefault();
        e.stopPropagation();
        const playerId = jailIcon.dataset.playerId;
        const p = players.find(pl => pl.id === playerId);
        if (p && p.inJail) {
          showJailPanel();
        }
      }
    });
    // M1-3区域点击显示棋子面板
    if (!panel._cardInfoDelegated) {
      panel._cardInfoDelegated = true;
      panel.addEventListener('click', (e) => {
        const card = e.target.closest('.player-card');
        if (!card) return;
        // 如果白框选目标模式（card上有选目标的onclick），优先响应选目标
        if (card.onclick) return;
        // 只有点击M1/M2/M3区域时才显示棋子面板
        const zone = e.target.closest('.m1-zone, .m2-zone, .m3-zone');
        if (!zone) return;
        const playerId = card.dataset.card;
        const p = players.find(pl => pl.id === playerId);
        if (!p || p.bankrupt) return;
        window.showTokenSalary(playerId, p.character, p.variant || '2', p.name, p.color, p.salary);
      });
    }
  }
}

window.selectHunshuiTarget = function(targetId) {
  if (!hunshuiSelectingTarget) return;
  hunshuiSelectingTarget = false;
  socket.emit('hunshuiSelectTarget', { targetId });
  refreshPlayerCards();
};

window.selectLianheTarget = function(targetId) {
  if (!lianheSelectingTarget) return;
  lianheSelectingTarget = false;
  socket.emit('lianheSelectTarget', { targetId });
  refreshPlayerCards();
};

window.selectErenTarget = function(targetId) {
  if (!erenSelectingTarget) return;
  erenSelectingTarget = false;
  socket.emit('erenSelectTarget', { targetId });
  refreshPlayerCards();
};

window.selectDiaohuTarget = function(targetId) {
  if (!diaohuSelectingTarget) return;
  diaohuSelectingTarget = false;
  socket.emit('diaohuSelectTarget', { targetId });
  refreshPlayerCards();
};

window.selectPaozhuanTarget = function(targetId) {
  if (!selectingPaozhuanTarget) return;
  selectingPaozhuanTarget = false;
  socket.emit('paozhuanSelectTarget', { targetId });
  refreshPlayerCards();
};

window.selectYuanjiaoTargetA = function(targetId) {
  if (!selectingYuanjiaoTargetA) return;
  selectingYuanjiaoTargetA = false;
  socket.emit('yuanjiaoSelectTargetA', { targetId });
  refreshPlayerCards();
};

window.selectYuanjiaoTargetB = function(targetId) {
  if (!selectingYuanjiaoTargetB) return;
  selectingYuanjiaoTargetB = false;
  socket.emit('yuanjiaoSelectTargetB', { targetId });
  refreshPlayerCards();
};

window.selectXianhaiTarget = function(targetId) {
  if (!selectingXianhaiTarget) return;
  selectingXianhaiTarget = false;
  socket.emit('xianhaiSelectTarget', { targetId });
  refreshPlayerCards();
};

window.selectShuimianTarget = function(targetId) {
  if (!selectingShuimianTarget) return;
  selectingShuimianTarget = false;
  socket.emit('shuimianTarget', { targetId });
  refreshPlayerCards();
};

window.selectXitieshiTarget = function(targetId) {
  if (!window.selectingXitieshiTarget) return;
  window.selectingXitieshiTarget = false;
  socket.emit('xitieshiSelectTarget', { targetId });
  refreshPlayerCards();
};

window.selectLijianTarget = function(targetId) {
  if (!window.selectingLijianTarget) return;
  socket.emit('lijianSelectTarget', { targetId });
  refreshPlayerCards();
};

window.selectGongchengTarget = function(targetId) {
  if (!window.selectingGongchengTarget) return;
  window.selectingGongchengTarget = false;
  window.gongchengTargetId = targetId;
  window.selectingGongchengProp = true;
  renderBoardOnly();
};

window.selectHezongTarget = function(targetId) {
  if (!selectingHezongTarget) return;
  selectingHezongTarget = false;
  waitingHezongTarget = true;
  $('areaE').innerHTML = '等待另一个玩家选择目标...';
  socket.emit('hezongAlliance', targetId);
  render();
};

window.selectSansiTarget = function(targetId) {
  if (!sansiSelectingTarget) return;
  sansiSelectingTarget = false;
  if (sansiPanelState && sansiPanelState.phase === 'selectRestTarget') {
    socket.emit('sansiRestTarget', { targetId });
  } else if (sansiPanelState && sansiPanelState.phase === 'otherSelectRestTarget') {
    socket.emit('sansiOtherRestTarget', { targetId });
  } else {
    socket.emit('sansiTargetSelect', { targetId });
  }
  refreshPlayerCards();
};

window.selectYingmoTarget = function(targetId) {
  if (!selectingYingmoTarget) return;
  selectingYingmoTarget = false;
  socket.emit('yingmoChooseTarget', { targetId });
  refreshPlayerCards();
};

window.selectSwapTarget = function(targetId) {
  if (!selectingSwapTarget) return;
  selectingSwapTarget = false;
  socket.emit('gaituSwapPlayer', { targetId });
  refreshPlayerCards();
};

window.selectRouletteTarget = function(targetId) {
  if (!selectingRouletteTarget) return;
  selectingRouletteTarget = false;
  rouletteExcludedIds = [];
  socket.emit('gaituRouletteShoot', { targetId });
  refreshPlayerCards();
};

window.selectStartTarget = function(targetId) {
  if (!selectingStartTarget) return;
  selectingStartTarget = false;
  startTargetIds = [];
  socket.emit('startTargetSelect', targetId);
  refreshPlayerCards();
};

window.selectIslandSwapTarget = function(targetId) {
  if (!selectingIslandSwapTarget) return;
  const bid = islandSwapBidsData.find(b => b.playerId === targetId);
  if (!bid) return;
  selectingIslandSwapTarget = false;
  islandSwapBidsData = [];
  socket.emit('islandSwapAccept', { targetId, price: bid.price });
  refreshPlayerCards();
};

window.selectJidiTarget = function(targetId) {
  if (!selectingJidiTarget) return;
  selectingJidiTarget = false;
  socket.emit('jidiChoice', { action: 'shoot', target: targetId });
  refreshPlayerCards();
  const btns = document.getElementById('jidiBtns');
  if (btns) btns.style.display = 'none';
};

window.selectGaichaoTarget = function(targetId) {
  if (!selectingGaichaoTarget) return;
  selectingGaichaoTarget = false;
  socket.emit('gaichaoSelect', { targetId });
  refreshPlayerCards();
};

window.selectBaijinTarget = function(targetId) {
  if (!selectingBaijinTarget) return;
  selectingBaijinTarget = false;
  socket.emit('baijinSelect', { targetId });
  refreshPlayerCards();
};

window.selectGuashaTarget = function(targetId) {
  if (!selectingGuashaTarget) return;
  selectingGuashaTarget = false;
  socket.emit('guashaSelect', { targetId });
  refreshPlayerCards();
};

window.selectJiaoyiTarget = function(targetId) {
  if (!selectingJiaoyiTarget) return;
  selectingJiaoyiTarget = false;
  socket.emit('jiaoyiSelectTarget', { targetId });
  refreshPlayerCards();
};

window.selectZemuerqiTarget = function(targetId) {
  if (!selectingZemuerqiTarget) return;
  selectingZemuerqiTarget = false;
  socket.emit('zemuerqiSelectTarget', { targetId });
  refreshPlayerCards();
};

window.selectNongminTarget = function(targetId) {
  if (!selectingNongminTarget) return;
  selectingNongminTarget = false;
  socket.emit('nongminSelectTarget', { targetId });
  refreshPlayerCards();
};

window.selectQiyuTarget = function(targetId) {
  if (!selectingQiyuTarget) return;
  selectingQiyuTarget = false;
  if (qiyuTargetId === 25) {
    socket.emit('cishanjiaSelect', { targetId });
  } else {
    socket.emit('qiyuTargetSelect', { targetId, qiyuId: qiyuTargetId });
  }
  qiyuTargetId = null;
  refreshPlayerCards();
};

window.selectQiangjieTarget = function(targetId) {
  if (!selectingQiangjieTarget) return;
  selectingQiangjieTarget = false;
  socket.emit('qiangjieTarget', { targetId });
  refreshPlayerCards();
};

window.selectLongjuanfengTarget = function(targetId) {
  if (!selectingLongjuanfengTarget) return;
  selectingLongjuanfengTarget = false;
  socket.emit('longjuanfengTarget', { targetId });
  refreshPlayerCards();
};

window.selectTingyeTarget = function(targetId) {
  if (!selectingTingyeTarget) return;
  selectingTingyeTarget = false;
  socket.emit('tingyeTarget', { targetId });
  refreshPlayerCards();
};

window.selectBingdongTarget = function(targetId) {
  if (!selectingBingdongTarget) return;
  selectingBingdongTarget = false;
  socket.emit('bingdongTarget', { targetId });
  refreshPlayerCards();
};

window.selectHeikeTarget = function(targetId) {
  if (!selectingHeikeTarget) return;
  selectingHeikeTarget = false;
  socket.emit('heikeTarget', { targetId });
  refreshPlayerCards();
};

window.selectJinghuaTarget = function(targetId) {
  if (!selectingJinghuaTarget) return;
  selectingJinghuaTarget = false;
  socket.emit('jinghuaTarget', { targetId });
  refreshPlayerCards();
};

window.selectQiyuAnmianyaoTarget = function(targetId) {
  if (!qiyuAnmianyaoSelecting) return;
  qiyuAnmianyaoSelecting = false;
  socket.emit('qiyuAnmianyaoTarget', { targetId });
  refreshPlayerCards();
};

window.selectQiyuFengdiTarget = function(targetId) {
  if (!qiyuFengdiSelecting) return;
  qiyuFengdiSelecting = false;
  socket.emit('fengdiSelectTarget', { targetId });
  refreshPlayerCards();
};

window.selectChuansongPlayerTarget = function(targetId) {
  if (!selectingChuansongPlayerTarget) return;
  selectingChuansongPlayerTarget = false;
  socket.emit('chuansongTarget', { targetId });
  refreshPlayerCards();
};

window.selectFengdiCardTarget = function(targetId) {
  if (!selectingFengdiCardTarget) return;
  selectingFengdiCardTarget = false;
  socket.emit('fengdiCardTarget', { targetId });
  refreshPlayerCards();
};

window.selectQiyuBaguanTarget = function(targetId) {
  if (!qiyuBaguanSelecting) return;
  qiyuBaguanSelecting = false;
  socket.emit('qiyuBaguanTarget', { targetId });
  refreshPlayerCards();
};

window.selectQiyuBafangQianniuTarget = function(targetId) {
  if (!qiyuBafangQianniuSelecting) return;
  qiyuBafangQianniuSelecting = false;
  socket.emit('qiyuBafangQianniuTarget', { targetId });
  refreshPlayerCards();
};

window.selectQiyuZaizangTarget = function(targetId) {
  if (!qiyuZaizangSelecting) return;
  qiyuZaizangSelecting = false;
  socket.emit('qiyuZaizangTarget', { targetId });
  refreshPlayerCards();
};

window.selectQiyuNilaiWangwangTarget = function(targetId) {
  if (!qiyuNilaiWangwangSelecting) return;
  socket.emit('qiyuNilaiWangwangTarget', { targetId });
  refreshPlayerCards();
};

window.selectQiyuMeirenjiTarget = function(targetId) {
  if (!qiyuMeirenjiSelecting) return;
  socket.emit('qiyuMeirenjiTarget', { targetId });
};

window.selectQiyuGuhuoTarget = function(targetId) {
  if (!qiyuGuhuoSelecting) return;
  qiyuGuhuoSelecting = false;
  socket.emit('qiyuGuhuoTarget', { targetId });
  refreshPlayerCards();
};

window.selectQiyuGanjinJuejueTarget = function(targetId) {
  if (!qiyuGanjinJuejueSelecting) return;
  qiyuGanjinJuejueSelecting = false;
  socket.emit('qiyuGanjinJuejueTarget', { targetId });
  refreshPlayerCards();
};

window.selectQiyuHunanganshiTarget = function(targetId) {
  if (!qiyuHunanganshiSelecting) return;
  qiyuHunanganshiSelecting = false;
  socket.emit('qiyuHunanganshiTarget', { targetId });
  refreshPlayerCards();
};

window.selectZangkuanTarget = function(targetId) {
  if (!zangkuanSelectingTarget) return;
  zangkuanSelectingTarget = false;
  socket.emit('zangkuanTarget', { targetId });
  refreshPlayerCards();
};

window.handleReconnect = function(playerId, playerName) {
  if (isLoadedGame) {
    const player = players.find(p => p.id === playerId || p.name === playerName);
    if (player) {
      localStorage.setItem('monopoly_player_name', playerName);
      socket.emit('reconnectPlayer', { playerId, playerName });
      $('gameContainer')?.classList.remove('hidden');
      $('actionBar')?.classList.remove('hidden');
      $('bottomBar')?.classList.remove('hidden');
      isLoadedGame = false;
    }
  } else if (isDisconnected) {
    const savedName = localStorage.getItem('monopoly_player_name');
    const savedChar = localStorage.getItem('monopoly_player_character');
    const savedVariant = localStorage.getItem('monopoly_player_variant');
    isDisconnected = false;
    $('gameContainer')?.classList.remove('hidden');
    $('actionBar')?.classList.remove('hidden');
    $('bottomBar')?.classList.remove('hidden');
    socket.connect();
    setTimeout(() => {
      if (socket.connected && hasJoined) {
        if (savedName && savedChar) {
          socket.emit('join', { name: savedName, character: savedChar, variant: savedVariant || '' });
        }
      }
    }, 500);
  } else {
    // 游戏进行中离线玩家重连
    localStorage.setItem('monopoly_player_name', playerName);
    socket.emit('reconnectPlayer', { playerId, playerName });
  }
};

window.selectFengkongTarget = function(targetId) {
  if (!fengkongSelectingTarget) return;
  fengkongSelectingTarget = false;
  socket.emit('fengkongSelectTarget', { targetId });
  refreshPlayerCards();
};

window.selectDaoyingTarget = function(targetId) {
  if (!daoyingSelectingTarget) return;
  daoyingSelectingTarget = false;
  socket.emit('daoyingSelectTargetConfirm', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
};

window.selectQiyuLianyinTarget = function(targetId) {
  if (!qiyuLianyinSelectingTarget) return;
  qiyuLianyinSelectingTarget = false;
  socket.emit('qiyuLianyinTarget', { targetId, propId: qiyuLianyinPropId });
  qiyuLianyinPropId = null;
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
};

window.selectQiyuYinhuoDefuProp = function(propId) {
  if (!qiyuYinhuoDefuSelecting) return;
  qiyuYinhuoDefuSelecting = false;
  socket.emit('qiyuYinhuoDefuProp', { propId });
  document.getElementById('areaF').innerHTML = '';
  render();
};

window.selectQiyuBomingTarget = function(targetId) {
  if (!qiyuBomingSelecting) return;
  qiyuBomingSelecting = false;
  socket.emit('qiyuBomingTarget', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectQiyuJinzuTarget = function(targetId) {
  if (!qiyuJinzuSelecting) return;
  qiyuJinzuSelecting = false;
  socket.emit('qiyuJinzuTarget', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectQiyuLiufangTarget = function(targetId) {
  if (!qiyuLiufangSelecting) return;
  qiyuLiufangSelecting = false;
  socket.emit('qiyuLiufangTarget', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectQiyuJiebanWanleTarget = function(targetId) {
  if (!qiyuJiebanWanleSelecting) return;
  qiyuJiebanWanleSelecting = false;
  socket.emit('qiyuJiebanWanleTarget', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectQiyuTuoleiTarget = function(targetId) {
  if (!qiyuTuoleiSelecting) return;
  qiyuTuoleiSelecting = false;
  socket.emit('qiyuTuoleiTarget', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectQiyuFuwufeiTarget = function(targetId) {
  if (!qiyuFuwufeiSelecting) return;
  qiyuFuwufeiSelecting = false;
  socket.emit('qiyuFuwufeiTarget', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectQiyuTudijianbingTarget = function(targetId) {
  if (!qiyuTudijianbingSelectingTarget) return;
  qiyuTudijianbingSelectingTarget = false;
  socket.emit('qiyuTudijianbingSelectTarget', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectQiyuXiaolicangdaoTarget = function(targetId) {
  if (!qiyuXiaolicangdaoSelectingTarget) return;
  qiyuXiaolicangdaoSelectingTarget = false;
  socket.emit('qiyuXiaolicangdaoConfirm', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectQiyuXiaduTarget = function(targetId) {
  if (!qiyuXiaduSelectingTarget) return;
  qiyuXiaduSelectingTarget = false;
  socket.emit('qiyuXiaduConfirm', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectQiyuJietouDouruTarget = function(targetId) {
  if (!qiyuJietouDouruSelectingTarget) return;
  qiyuJietouDouruSelectingTarget = false;
  socket.emit('qiyuJietouDouruConfirm', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectQiyuAnduchengcangTarget = function(targetId) {
  if (!qiyuAnduchengcangSelectingTarget) return;
  qiyuAnduchengcangSelectingTarget = false;
  socket.emit('qiyuAnduchengcangSelectTarget', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectQiyuQiankundanayiTarget = function(targetId) {
  if (!qiyuQiankundanayiSelectingTarget) return;
  qiyuQiankundanayiSelectingTarget = false;
  socket.emit('qiyuQiankundanayiConfirm', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectHezuorenwuTarget = function(targetId) {
  if (!window.hezuorenwuSelectingTarget) return;
  window.hezuorenwuSelectingTarget = false;
  socket.emit('hezuorenwuSelectTarget', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectMeihuoTarget = function(targetId) {
  if (!window.meihuoSelectingTarget) return;
  window.meihuoSelectingTarget = false;
  socket.emit('meihuoSelectTarget', { targetId });
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectPinqianTarget = function(targetId) {
  if (!selectingPinqianTarget) return;
  selectingPinqianTarget = false;
  socket.emit('pinqianSelect', targetId);
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
  render();
};

window.selectTexasTarget = function(targetId) {
  if (!selectingTexasPlayer) return;
  selectingTexasPlayer = false;
  socket.emit('texasSelectPlayer', targetId);
  document.getElementById('areaF').innerHTML = '';
  refreshPlayerCards();
};

socket.on('autoRollDice', (diceVal) => {
  waitingForTurnEnd = true;
  updateGAreaDiceImage(diceVal, true);
  socket.emit('rollDice', diceVal);
});

socket.on('colorDiceSumDisplay', ({ playerId, dice1, dice2, sum }) => {
  colorDiceSumValues = { dice1, dice2 };
  ensureGAreaExists();
  const areaG = $('areaG');
  if (areaG) {
    areaG.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;gap:4px;"><img src="/drawable/touzi/t${dice1}.png" style="width:45%;height:auto;"><img src="/drawable/touzi/t${dice2}.png" style="width:45%;height:auto;"></div>`;
    areaG.style.cursor = 'not-allowed';
    areaG.style.opacity = '0.6';
    areaG.onclick = null;
  }
});

socket.on('colorDiceResult', (data) => {
  waitingForTurnEnd = true;
  if (typeof data === 'object' && data.dice1 && data.dice2) {
    colorDiceSumValues = { dice1: data.dice1, dice2: data.dice2 };
  }
  ensureGAreaExists();
  const areaG = $('areaG');
  if (areaG) {
    if (typeof data === 'object' && data.dice1 && data.dice2) {
      areaG.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;gap:4px;"><img src="/drawable/touzi/t${data.dice1}.png" style="width:45%;height:auto;"><img src="/drawable/touzi/t${data.dice2}.png" style="width:45%;height:auto;"></div>`;
    } else if (typeof data === 'object' && data.rawDice) {
      areaG.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;"><img src="/drawable/touzi/t${data.rawDice}.png" style="width:80%;height:auto;"></div>`;
    } else {
      const diceVal = typeof data === 'object' ? data.sum : data;
      areaG.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:bold;color:#fff;">${diceVal}</div>`;
    }
    areaG.style.cursor = 'not-allowed';
    areaG.style.opacity = '0.6';
    areaG.onclick = null;
  }
  if (typeof data === 'object' && data.rawDice) {
    // moneyPlus: 显示TIP，按rawDice+2移动
    const me = players.find(p => p.id === myId);
    const imgSrc = `/drawable/kapian/caisetouzi.png`;
    showPopupMessage(`<img src="${imgSrc}" style="width:60px;height:60px;object-fit:contain;"><span>掷出${data.rawDice}点数+2，获得金钱${data.moveSteps}</span>`);
    socket.emit('rollDice', data.moveSteps);
  } else if (typeof data === 'object' && data.dice1 && data.dice2) {
    socket.emit('rollDice', data.sum);
  } else {
    const diceVal = typeof data === 'object' ? data.sum : data;
    socket.emit('rollDice', diceVal);
  }
});

socket.on('colorDiceMoneyPlus', ({ playerId, playerName, playerColor, rawDice, moveSteps }) => {
  const imgSrc = `/drawable/kapian/caisetouzi.png`;
  addTip(`<img src="${imgSrc}" style="width:60px;height:60px;object-fit:contain;"><span>${coloredName(playerName, playerColor)}掷出${rawDice}点数+2，获得金钱${moveSteps}</span>`);
});

socket.on('colorDiceChooseOne', ({ dice1, dice2 }) => {
  const areaF = document.getElementById('areaF');
  if (areaF) {
    areaF.innerHTML = `
      <div style="display:flex;gap:8px;justify-content:center;align-items:center;">
        <img src="/drawable/touzi/T${dice1}.png" style="width:50px;height:50px;cursor:pointer;border-radius:4px;" class="dice-choose-one" data-dice="${dice1}">
        <img src="/drawable/touzi/T${dice2}.png" style="width:50px;height:50px;cursor:pointer;border-radius:4px;" class="dice-choose-one" data-dice="${dice2}">
      </div>
    `;
    areaF.querySelectorAll('.dice-choose-one').forEach(img => {
      img.onclick = () => {
        const diceValue = parseInt(img.dataset.dice);
        areaF.innerHTML = '';
        socket.emit('colorDiceChooseOneSelect', { diceValue });
      };
    });
  }
});

socket.on('colorDiceSelfChoose', () => {
  showDiceSelectInF(1, 6, (diceValue) => {
    socket.emit('colorDiceChooseSelect', { diceValue });
  });
});

socket.on('qiangjieSelectTarget', () => {
  selectingQiangjieTarget = true;
  refreshPlayerCards();
});

socket.on('cardConfirmPopup', ({ cardName, image, description, reason, isTarget }) => {
  if (reason === 'mianlufei') {
    showTck(`/drawable/kapian/${image}.png`, description, [
      { label: '使用', callback: () => { socket.emit('cardConfirmResponse', { use: true }); socket.emit('clearBottomBarOverlay'); } },
      { label: '不用', danger: true, callback: () => { socket.emit('cardConfirmResponse', { use: false }); socket.emit('clearBottomBarOverlay'); } }
    ]);
  } else if (cardName === '免休卡') {
    showTck(`/drawable/kapian/${image}.png`, description, [
      { label: '使用', callback: () => { socket.emit('cardConfirmResponse', { use: true }); socket.emit('clearBottomBarOverlay'); } },
      { label: '不用', danger: true, callback: () => { socket.emit('cardConfirmResponse', { use: false }); socket.emit('clearBottomBarOverlay'); } }
    ]);
  } else {
    showTck(`/drawable/kapian/${image}.png`, description, [
      { label: '使用', callback: () => { socket.emit('cardConfirmResponse', { use: true }); socket.emit('clearBottomBarOverlay'); } },
      { label: '不用', danger: true, callback: () => { socket.emit('cardConfirmResponse', { use: false }); socket.emit('clearBottomBarOverlay'); } }
    ]);
  }
});

socket.on('koiDuogongnengConfirm', ({ cards }) => {
  let rowsHtml = '<div class="tck-multi-rows">';
  cards.forEach((card) => {
    rowsHtml += `<div class="tck-multi-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;">
      <span class="tck-text" style="flex:1;">${card.text}</span>
      <button class="tck-option-btn koi-use-btn" data-type="${card.hiddenType}">使用</button>
    </div>`;
  });
  rowsHtml += '<div style="text-align:right;padding:4px 0;"><button class="tck-option-btn danger koi-skip-btn">不用</button></div></div>';
  const stip = showTck('', '', null);
  stip.onclick = null;
  const contentDiv = stip.querySelector('.tck-content');
  contentDiv.innerHTML = rowsHtml;
  stip.querySelectorAll('.koi-use-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      socket.emit('hiddenCardChoice', { hiddenType: btn.dataset.type });
      socket.emit('clearBottomBarOverlay');
      dismissTck(parseInt(stip.dataset.msgId));
    };
  });
  stip.querySelector('.koi-skip-btn').onclick = (e) => {
    e.stopPropagation();
    socket.emit('hiddenCardChoice', { hiddenType: null });
    socket.emit('clearBottomBarOverlay');
    dismissTck(parseInt(stip.dataset.msgId));
  };
});

socket.on('koiDuogongnengOverlay', ({ imgs }) => {
  if (imgs.length === 1) {
    showBottomBarOverlay(imgs[0]);
  } else if (imgs.length === 2) {
    const bottomBar = $('bottomBar');
    if (!bottomBar) return;
    let overlay = document.getElementById('bottomBarOverlay');
    const barHeight = bottomBar.offsetHeight || 80;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'bottomBarOverlay';
      overlay.style.cssText = `position:absolute;top:0;left:0;width:100%;height:${barHeight}px;background:rgba(0,0,0,1);display:flex;align-items:center;justify-content:center;z-index:1000;overflow:hidden;gap:10px;`;
      bottomBar.style.position = 'relative';
      bottomBar.appendChild(overlay);
    }
    const imgH = Math.min(60, (overlay.offsetHeight || 80) - 20);
    overlay.innerHTML = imgs.map(src => `<img src="${src}" style="width:45%;height:${imgH}px;object-fit:contain;">`).join('');
  }
});

socket.on('clearBottomBarOverlay', () => {
  hideBottomBarOverlay();
});

socket.on('hiddenCardMultiConfirm', ({ cards, sourceName, sourceColor, isTarget }) => {
  // 只有目标玩家才显示H区选项
  if (!isTarget) {
    return;
  }
  let panel = document.getElementById('cardConfirmPanel');
  if (panel) panel.remove();
  let rowsHtml = '';
  cards.forEach((card, idx) => {
    rowsHtml += `<div class="tck-multi-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;">
      <span class="tck-text" style="flex:1;">${card.text}</span>
      <button class="tck-option-btn hidden-use-btn" data-type="${card.hiddenType}">使用</button>
    </div>`;
  });
  rowsHtml += `<div style="text-align:right;padding:4px 0;"><button class="tck-option-btn danger hidden-skip-btn">不用</button></div>`;
  const stip = showTck('/drawable/kapian/yincang.png', '', null);
  stip.onclick = null; // TCK有选项按钮，不应点击空白处消失
  const contentDiv = stip.querySelector('.tck-content');
  contentDiv.innerHTML = `<div class="tck-multi-rows">${rowsHtml}</div>`;
  stip.querySelectorAll('.hidden-use-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      socket.emit('hiddenCardChoice', { hiddenType: btn.dataset.type });
      socket.emit('clearBottomBarOverlay');
      dismissTck(parseInt(stip.dataset.msgId));
    };
  });
  stip.querySelector('.hidden-skip-btn').onclick = (e) => {
    e.stopPropagation();
    socket.emit('hiddenCardChoice', { hiddenType: null });
    socket.emit('clearBottomBarOverlay');
    dismissTck(parseInt(stip.dataset.msgId));
  };
});

// 隐藏卡覆盖bottomBar（所有玩家）
socket.on('hiddenCardOverlay', ({ targetPlayerId, cards, targetName, targetColor }) => {
  showBottomBarOverlay('/drawable/kapian/yincang.png');
});

// 关闭隐藏卡覆盖
socket.on('hiddenCardOverlayClose', () => {
  hideBottomBarOverlay();
});

// 卡片确认覆盖bottomBar（所有玩家，包括免休卡等）
socket.on('cardConfirmOverlay', ({ targetPlayerId, cardName, cardImage, targetName, targetColor }) => {
  showBottomBarOverlay(`/drawable/kapian/${cardImage}.png`);
});

socket.on('cardConfirmOverlayClose', () => {
  hideBottomBarOverlay();
});

socket.on('hiddenCardReveal', ({ cardName, description, hiddenType }) => {
  let panel = document.getElementById('cardConfirmPanel');
  if (panel) panel.remove();
  showTck('/drawable/kapian/yincang.png', `隐藏卡转换为：<br><b>${cardName}</b><br>${description}`, [
    { label: '确定', callback: () => {} }
  ]);
});

socket.on('selectHiddenTransferTarget', ({ players: targetPlayers, sourceName }) => {
  let panel = document.getElementById('cardConfirmPanel');
  if (panel) panel.remove();
  const options = targetPlayers.map(p => ({
    label: p.name,
    callback: () => { socket.emit('hiddenTransferTarget', p.id); }
  }));
  showTck('/drawable/kapian/yincang.png', '请选择转移目标：', options);
});

socket.on('baohuQuery', ({ propertyName, currentPlayerName, currentPlayerColor }) => {
  showTck('/drawable/kapian/baohu.png', `${coloredName(currentPlayerName, currentPlayerColor)}选择了你的${propertyName}，是否使用保护卡？`, [
    { label: '使用', callback: () => { socket.emit('baohuConfirm', { useProtect: true }); socket.emit('clearBottomBarOverlay'); } },
    { label: '不用', danger: true, callback: () => { socket.emit('baohuConfirm', { useProtect: false }); socket.emit('clearBottomBarOverlay'); } }
  ]);
});

socket.on('baohuOverlay', ({ targetPlayerId, targetName, targetColor }) => {
  // 不是触发者才显示覆盖
  if (socket.id === targetPlayerId) return;
  showBottomBarOverlay('/drawable/kapian/baohu.png');
});

socket.on('chuansongSelectTarget', ({ canSelectSelf }) => {
  selectingChuansongPlayerTarget = true;
  chuansongCanSelectSelf = canSelectSelf;
  refreshPlayerCards();
});

socket.on('fengdiCardSelectTarget', ({ canSelectSelf }) => {
  selectingFengdiCardTarget = true;
  fengdiCardCanSelectSelf = canSelectSelf;
  refreshPlayerCards();
});

socket.on('chuansongSelectBoard', () => {
  selectingChuansongTarget = true;
  renderBoardOnly();
  setTimeout(() => {
    document.querySelectorAll('.space').forEach(el => {
      el.style.outline = '2px solid #fff'; el.style.outlineOffset = '-2px';
      el.style.cursor = 'pointer';
      el.classList.add('chuansong-selectable');
    });
  }, 50);
});

socket.on('shanxianSelectBoard', () => {
  selectingShanxianTarget = true;
  renderBoardOnly();
  setTimeout(() => {
    const cur = players[currentPlayerIdx];
    if (!cur) return;
    const BOARD_SIZE = board.length;
    const curPos = cur.position;
    const validPositions = new Set();
    for (let i = 1; i <= 3; i++) {
      validPositions.add((curPos + i) % BOARD_SIZE);
      validPositions.add((curPos - i + BOARD_SIZE) % BOARD_SIZE);
    }
    document.querySelectorAll('.space').forEach(el => {
      const spaceId = parseInt(el.dataset.id);
      if (validPositions.has(spaceId)) {
        el.style.outline = '2px solid #fff'; el.style.outlineOffset = '-2px';
        el.style.cursor = 'pointer';
        el.classList.add('shanxian-selectable');
      }
    });
  }, 50);
});

socket.on('tingyeSelectTarget', ({ canSelectSelf }) => {
  selectingTingyeTarget = true;
  tingyeCanSelectSelf = canSelectSelf;
  refreshPlayerCards();
});

socket.on('longjuanfengSelectTarget', ({ canSelectSelf }) => {
  selectingLongjuanfengTarget = true;
  longjuanfengCanSelectSelf = canSelectSelf;
  refreshPlayerCards();
});

socket.on('bingdongSelectTarget', ({ canSelectSelf }) => {
  selectingBingdongTarget = true;
  bingdongCanSelectSelf = canSelectSelf;
  refreshPlayerCards();
});

socket.on('heikeShowSelectTarget', () => {
  selectingHeikeTarget = true;
  refreshPlayerCards();
});

socket.on('jinghuaSelectTarget', () => {
  selectingJinghuaTarget = true;
  refreshPlayerCards();
});

socket.on('luzhangSelectPosition', ({ currentPosition }) => {
  selectingLuzhangPosition = true;
  renderBoardOnly();
  const boardSize = 36;
  const positions = [];
  for (let i = 1; i <= 6; i++) {
    const forward = (currentPosition + i) % boardSize;
    const backward = (currentPosition - i + boardSize) % boardSize;
    if (!positions.includes(forward)) positions.push(forward);
    if (!positions.includes(backward)) positions.push(backward);
  }
  positions.forEach(pos => {
    const cell = document.querySelector(`.space[data-id="${pos}"]`);
    if (cell) {
      cell.style.outline = '2px solid #fff'; cell.style.outlineOffset = '-2px';
      cell.style.cursor = 'pointer';
      cell.onclick = () => {
        selectingLuzhangPosition = false;
        document.querySelectorAll('.space').forEach(c => {
          c.style.outline = '';
          c.style.cursor = '';
          c.onclick = null;
        });
        socket.emit('luzhangSelect', { position: pos });
      };
    }
  });
});

socket.on('luzhangPlaced', ({ position }) => {
  if (!luzhangPositions.includes(position)) {
    luzhangPositions.push(position);
  }
  renderBoardOnly();
});

socket.on('luzhangTriggered', ({ position }) => {
  luzhangPositions = luzhangPositions.filter(p => p !== position);
  renderBoardOnly();
});

socket.on('qiangjieResult', ({ win, targetName, targetColor, targetMoney, targetCards, targetId }) => {
  if (!win) return;
  let optionsHtml = '<div class="tck-options" style="flex-wrap:wrap;gap:8px;justify-content:center;">';
  optionsHtml += `<button class="tck-option-btn" data-loot="money">$7</button>`;
  if (targetCards && targetCards.length > 0) {
    targetCards.forEach((card, idx) => {
      optionsHtml += `<img src="/drawable/kapian/${card.image}.png" class="tck-card-option" data-loot="card" data-idx="${idx}" style="height:60px;width:auto;object-fit:contain;cursor:pointer;border-radius:4px;transition:transform 0.2s;">`;
    });
  }
  optionsHtml += '</div>';
  const stip = showTck('/drawable/kapian/qiangjie.png', '抢劫成功，请选择掠夺资产', null);
  stip.onclick = null;
  const contentDiv = stip.querySelector('.tck-content');
  contentDiv.innerHTML = `<div class="tck-text" style="text-align:center;">抢劫成功，请选择掠夺资产</div>${optionsHtml}`;
  stip.querySelector('button[data-loot="money"]').onclick = (e) => {
    e.stopPropagation();
    socket.emit('qiangjieLoot', { targetId, lootType: 'money', lootIndex: -1 });
    dismissTck(parseInt(stip.dataset.msgId));
  };
  stip.querySelectorAll('img.tck-card-option').forEach(img => {
    img.onmouseenter = () => { img.style.transform = 'scale(1.1)'; };
    img.onmouseleave = () => { img.style.transform = 'scale(1)'; };
    img.onclick = (e) => {
      e.stopPropagation();
      const idx = parseInt(img.dataset.idx);
      socket.emit('qiangjieLoot', { targetId, lootType: 'card', lootIndex: idx });
      dismissTck(parseInt(stip.dataset.msgId));
    };
  });
});

function showMyAssetPanel() {
  const me = players.find(p => p.id === myId);
  if (!me) return;
  const boardEl = $('board');
  if (!boardEl) return;
  
  let existingPanel = document.getElementById('myAssetPanel');
  if (existingPanel) existingPanel.remove();
  
  const panel = document.createElement('div');
  panel.id = 'myAssetPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:100;display:flex;flex-direction:column;align-items:center;background:rgba(0,0,0,1);padding:8px;box-sizing:border-box;overflow:hidden;';
  
  let html = '';
  html += `<div style="color:#fff;font-size:clamp(14px,3vw,24px);font-weight:bold;margin-bottom:8px;flex-shrink:0;">${me.name}的所有资产</div>`;
  
  html += '<div style="flex:1;overflow-y:auto;overflow-x:hidden;width:100%;display:flex;flex-direction:column;align-items:center;gap:8px;scrollbar-width:none;">';
  
  if (me.petImage) {
    const displayPet = me.originalPetImage || me.petImage;
    const isCwq = displayPet.startsWith('cw');
    const petSrc = isCwq ? `/drawable/chongwu/chongwu2/${displayPet}` : `/drawable/chongwu/${displayPet}`;
    html += `<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;">`;
    html += `<img src="${petSrc}" style="width:clamp(60px,15vw,120px);height:clamp(60px,15vw,120px);object-fit:contain;cursor:pointer;border-radius:8px;" class="asset-item" data-asset-type="pet" data-asset-id="petImage">`;
    html += '</div>';
  }
  
  const myProps = board.filter(s => s.isProperty && s.owner === me.id);
  if (myProps.length > 0) {
    html += '<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:4px;">';
    myProps.forEach(prop => {
      html += `<button class="jail-btn asset-item" data-asset-type="property" data-asset-id="${prop.id}" style="font-size:clamp(10px,2vw,14px);padding:4px 8px;">${prop.name}</button>`;
    });
    html += '</div>';
  }
  
  if (me.hasDiamond || (me.cards && me.cards.length > 0)) {
    html += '<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:4px;">';
    if (me.hasDiamond) {
      html += `<img src="/drawable/ditu/zuanshi.png" style="width:clamp(50px,15vw,120px);height:clamp(50px,15vw,120px);object-fit:contain;cursor:pointer;border-radius:8px;" class="asset-item" data-asset-type="diamond" data-asset-id="diamond">`;
    }
    if (me.cards && me.cards.length > 0) {
      me.cards.forEach((c, i) => {
        html += `<img src="/drawable/kapian/${c.image}.png" style="width:clamp(50px,15vw,120px);height:clamp(50px,15vw,120px);object-fit:contain;cursor:pointer;border-radius:8px;" class="asset-item" data-asset-type="card" data-asset-id="${i}">`;
      });
    }
    html += '</div>';
  }
  
  html += '</div>';
  
  panel.innerHTML = html;
  boardEl.style.position = 'relative';
  boardEl.appendChild(panel);
  
  panel.querySelectorAll('.asset-item').forEach(el => {
    el.onclick = () => {
      const assetType = el.dataset.assetType;
      const assetId = el.dataset.assetId;
      panel.remove();
      socket.emit('myAssetAuction', { assetType, assetId });
    };
  });
}

function showYianPanel(targetAName, targetAColor, targetBName, targetBColor) {
  let panel = document.getElementById('yianPanel');
  if (panel) panel.remove();
  
  const me = players.find(p => p.id === myId);
  const maxMoney = me ? (me.money + (me.tempMoney || 0)) : 0;
  
  panel = document.createElement('div');
  panel.id = 'yianPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:200;background:#1a2a4a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;';
  
  panel.innerHTML = `
    <img src="/drawable/jiyu/yian.jpg" style="width:200px;height:200px;object-fit:contain;border-radius:8px;">
    <div style="color:#fff;font-size:20px;text-align:center;">随机的两玩家是${coloredName(targetAName, targetAColor)}，${coloredName(targetBName, targetBColor)}</div>
    <div style="display:flex;align-items:center;gap:10px;">
      <input type="text" id="yianNumber" value="0" readonly style="width:100px;text-align:center;font-size:28px;background:#fff;color:#000;border:1px solid #666;padding:8px;border-radius:4px;font-weight:bold;">
      <button id="yianClearBtn" class="yian-calc-btn" disabled style="color:transparent;">清零</button>
      <button id="yianConfirmBtn" class="yian-calc-btn" disabled style="color:transparent;">确定</button>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="yian-calc-btn yian-num" data-val="0">0</button>
      <button class="yian-calc-btn yian-num" data-val="1">1</button>
      <button class="yian-calc-btn yian-num" data-val="2">2</button>
      <button class="yian-calc-btn yian-num" data-val="3">3</button>
      <button class="yian-calc-btn yian-num" data-val="4">4</button>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="yian-calc-btn yian-num" data-val="5">5</button>
      <button class="yian-calc-btn yian-num" data-val="6">6</button>
      <button class="yian-calc-btn yian-num" data-val="7">7</button>
      <button class="yian-calc-btn yian-num" data-val="8">8</button>
      <button class="yian-calc-btn yian-num" data-val="9">9</button>
    </div>
  `;
  
  const style = document.createElement('style');
  style.textContent = `.yian-calc-btn { min-width:50px;height:50px;background:#333;color:#fff;border:none;border-radius:8px;font-size:20px;cursor:pointer;padding:0 12px; } .yian-calc-btn:hover { background:#555; } .yian-calc-btn:disabled { background:#333 !important; color:transparent !important; opacity:1 !important; }`;
  panel.appendChild(style);
  
  document.getElementById('hArea').appendChild(panel);
  
  let currentValue = '0';
  const updateDisplay = () => {
    const numEl = $('yianNumber');
    const clearBtn = $('yianClearBtn');
    const confirmBtn = $('yianConfirmBtn');
    if (numEl) numEl.value = currentValue;
    const num = parseInt(currentValue);
    if (clearBtn) {
      clearBtn.disabled = num === 0;
      clearBtn.style.color = num === 0 ? 'transparent' : '#fff';
    }
    if (confirmBtn) {
      confirmBtn.disabled = num === 0;
      confirmBtn.style.color = num === 0 ? 'transparent' : '#fff';
    }
  };
  
  document.querySelectorAll('.yian-num').forEach(btn => {
    btn.onclick = () => {
      const val = btn.dataset.val;
      let newValue;
      if (currentValue === '0') {
        newValue = val;
      } else {
        newValue = currentValue + val;
      }
      if (newValue.length > 3) newValue = newValue.slice(0, 3);
      if (parseInt(newValue) > 999) {
        return;
      }
      currentValue = newValue;
      updateDisplay();
    };
  });
  
  const clearBtn = $('yianClearBtn');
  if (clearBtn) {
    clearBtn.onclick = () => {
      currentValue = '0';
      updateDisplay();
    };
  }
  
  const confirmBtn = $('yianConfirmBtn');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      const amount = parseInt(currentValue);
      if (amount > 0) {
        panel.remove();
        socket.emit('yianConfirm', { amount });
      }
    };
  }
}

function showFengkongDicePanel(targetId) {
  showDiceSelectInF(1, 6, (diceValue) => {
    socket.emit('fengkongSelectDice', { diceValues: [diceValue] });
  });
}

function showXiaotouPanel(othersWithCards) {
  let panel = document.getElementById('xiaotouPanel');
  if (panel) panel.remove();
  panel = document.createElement('div');
  panel.id = 'xiaotouPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:200;background:#000;display:flex;flex-direction:column;padding:4px;overflow-y:auto;';
  othersWithCards.slice(0, 5).forEach(p => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;flex:1;min-height:0;max-height:calc(100% / 5);';
    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'color:#fff;font-size:14px;white-space:nowrap;margin-right:8px;flex-shrink:0;';
    nameSpan.textContent = p.name;
    row.appendChild(nameSpan);
    const cardsContainer = document.createElement('div');
    cardsContainer.style.cssText = 'display:flex;overflow-x:auto;flex:1;gap:4px;align-items:center;height:100%;';
    (p.cards || []).forEach((card, idx) => {
      const cardImg = document.createElement('img');
      cardImg.src = `/drawable/kapian/${card.image}.png`;
      cardImg.style.cssText = 'height:90%;width:auto;object-fit:contain;cursor:pointer;flex-shrink:0;border-radius:4px;border:2px solid transparent;transition:border-color 0.2s;';
      cardImg.onmouseenter = () => { cardImg.style.borderColor = '#fff'; };
      cardImg.onmouseleave = () => { cardImg.style.borderColor = 'transparent'; };
      cardImg.onclick = () => {
        panel.remove();
        socket.emit('xiaotouSelectCard', { targetId: p.id, cardIndex: idx });
      };
      cardsContainer.appendChild(cardImg);
    });
    row.appendChild(cardsContainer);
    panel.appendChild(row);
  });
  document.getElementById('hArea').appendChild(panel);
}

function showQianbianPanel(allPlayersWithCards) {
  let panel = document.getElementById('qianbianPanel');
  if (panel) panel.remove();
  panel = document.createElement('div');
  panel.id = 'qianbianPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:200;background:#000;display:flex;flex-direction:column;padding:4px;overflow-y:auto;';
  allPlayersWithCards.slice(0, 6).forEach(p => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;flex:1;min-height:0;max-height:calc(100% / 6);';
    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'color:#fff;font-size:14px;white-space:nowrap;margin-right:8px;flex-shrink:0;';
    nameSpan.textContent = p.name;
    row.appendChild(nameSpan);
    const cardsContainer = document.createElement('div');
    cardsContainer.style.cssText = 'display:flex;overflow-x:auto;flex:1;gap:4px;align-items:center;height:100%;';
    (p.cards || []).forEach((card, idx) => {
      const cardImg = document.createElement('img');
      cardImg.src = `/drawable/kapian/${card.image}.png`;
      cardImg.style.cssText = 'height:90%;width:auto;object-fit:contain;cursor:pointer;flex-shrink:0;border-radius:4px;border:2px solid transparent;transition:border-color 0.2s;';
      cardImg.onmouseenter = () => { cardImg.style.borderColor = '#fff'; };
      cardImg.onmouseleave = () => { cardImg.style.borderColor = 'transparent'; };
      cardImg.onclick = () => {
        panel.remove();
        socket.emit('qianbianSelectCard', { targetId: p.id, cardIndex: idx });
      };
      cardsContainer.appendChild(cardImg);
    });
    row.appendChild(cardsContainer);
    panel.appendChild(row);
  });
  document.getElementById('hArea').appendChild(panel);
}

window.toggleCardPackPanel = function() {
  let panel = document.getElementById('cardPackPanel');
  if (panel) return;
  const me = players.find(p => p.id === myId);
  if (!me) return;
  panel = document.createElement('div');
  panel.id = 'cardPackPanel';
  panel.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:101;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,1);';
  let cardsHtml = '';
  if (me.cards && me.cards.length > 0) {
    cardsHtml += me.cards.map(c => {
      const isHiddenSub = c.hiddenType && c.name.startsWith('隐藏卡·');
      const displayName = isHiddenSub ? '隐藏卡' : c.name;
      const displayDesc = isHiddenSub ? '隐藏卡：效果仅卡主可见' : c.description;
      return `<img src="/drawable/kapian/${c.image}.png" class="card-thumb" style="cursor:pointer;height:80px;width:auto;object-fit:contain;border-radius:4px;" data-card-name="${displayName}" data-card-desc="${displayDesc}" onclick="window._testCardClick(this)">`;
    }).join('');
  }
  if (me.extraPets && me.extraPets.length > 0) {
    cardsHtml += me.extraPets.map(pet => {
      const isCwqPet = pet.startsWith('cw');
      const petSrc = isCwqPet ? `/drawable/chongwu/chongwu2/${pet}` : `/drawable/chongwu/${pet}`;
      const info = getPetInfo(pet);
      const infoText = info ? `<div style="color:#fff;font-size:9px;text-align:center;line-height:1.2;margin-top:2px;word-break:break-all;">${info.name}：${info.desc}</div>` : '';
      return `<div style="display:flex;flex-direction:column;align-items:center;"><img src="${petSrc}" class="card-thumb pet-thumb" style="cursor:pointer;height:80px;width:auto;object-fit:contain;border-radius:4px;">${infoText}</div>`;
    }).join('');
  }
  if (!cardsHtml) cardsHtml = '<span style="color:#888;font-size:20px;">卡包为空</span>';
  panel.innerHTML = `<div style="position:absolute;top:10px;right:15px;font-size:28px;color:#fff;cursor:pointer;z-index:102;" onclick="document.getElementById('cardPackPanel')?.remove()">×</div>
<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:20px;width:100%;height:100%;overflow-y:auto;scrollbar-width:none;align-content:start;box-sizing:border-box;">${cardsHtml}</div>`;
  panel.style.cssText += ';scrollbar-width:none;';
  document.getElementById('hArea').appendChild(panel);
  initCardTooltip();
  initDiamondTooltip();
};

// 棋子面板：点击棋子后出现的面板
window.showTokenSalary = function(playerId, character, variant, name, color, salary) {
  let panelTop = document.getElementById('tokenSalaryPanelTop');
  let panelBottom = document.getElementById('tokenSalaryPanelBottom');
  if (panelTop) panelTop.remove();
  if (panelBottom) panelBottom.remove();
  
  const player = players.find(p => p.id === playerId);
  const isMe = playerId === myId;
  const actionBar = document.getElementById('actionBar');
  const bottomBar = document.getElementById('bottomBar');
  const areaE = document.getElementById('areaE');
  if (!actionBar || !bottomBar || !areaE) return;
  
  const actionBarRect = actionBar.getBoundingClientRect();
  const bottomBarRect = bottomBar.getBoundingClientRect();
  const areaERect = areaE.getBoundingClientRect();
  
  // 棋子图片面板（显示在E区上面）- 初始显示MP4循环播放，点击切换为静态图片
  let htmlTop = '';
  htmlTop += `<div id="tokenPanelImgWrap" style="height:200px;width:auto;object-fit:contain;cursor:pointer;display:flex;align-items:center;justify-content:center;" data-character="${character}" data-variant="${variant}">
    <img id="tokenPanelStaticImg" src="/drawable/juese/${character}${variant}.png" style="height:200px;width:auto;object-fit:contain;display:none;">
    <video id="tokenPanelVideo" src="/drawable/juese/MP4/${character}${variant}.mp4" style="height:200px;width:auto;object-fit:contain;display:block;" loop muted autoplay playsinline></video>
  </div>`;
  
  panelTop = document.createElement('div');
  panelTop.id = 'tokenSalaryPanelTop';
  panelTop.style.cssText = `position:fixed;left:0;right:0;z-index:50;display:flex;align-items:center;justify-content:center;color:#fff;overflow:hidden;pointer-events:auto;`;
  panelTop.style.top = (actionBarRect.top - 204) + 'px';
  panelTop.style.height = '200px';
  panelTop.innerHTML = htmlTop;
  
  document.body.appendChild(panelTop);

  // 点击棋子面板切换MP4/静态图片（初始为MP4，点击后显示图片）
  const imgWrap = document.getElementById('tokenPanelImgWrap');
  if (imgWrap) {
    imgWrap.addEventListener('click', () => {
      const staticImg = document.getElementById('tokenPanelStaticImg');
      const video = document.getElementById('tokenPanelVideo');
      if (!staticImg || !video) return;
      if (video.style.display !== 'none') {
        // 当前显示MP4，点击后切换为图片
        video.style.display = 'none';
        video.pause();
        staticImg.style.display = 'block';
      } else {
        // 当前显示图片，点击后切换为MP4
        staticImg.style.display = 'none';
        video.style.display = 'block';
        video.currentTime = 0;
        video.play().catch(() => {});
      }
    });
  }
  
  // 其他内容面板（显示在H区以下）
  let htmlBottom = '';
  htmlBottom += `<div style="position:absolute;top:4px;right:8px;width:20px;height:20px;background:#e74c3c;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;font-weight:bold;line-height:1;z-index:10;" id="tokenPanelClose">×</div>`;
  
  htmlBottom += `<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-start;height:100%;padding:4px 8px;gap:4px;width:100%;">`;
  
  // 第一排：角色名字
  htmlBottom += `<div style="display:flex;align-items:center;justify-content:center;gap:6px;font-size:20px;flex-shrink:0;width:100%;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;touch-action:pan-x;" id="tokenNameRow"><style>#tokenNameRow::-webkit-scrollbar{display:none;}</style>`;
  const frozenText = player && player.frozen > 0 ? `/冻结${player.frozen}` : '';
  const bomingFrozenText = player && player.bomingFrozen ? `/冻结${player.money}` : '';
  const loanText = player && player.loans && player.loans.length > 0 ? player.loans.map(l => `/还款${l.installment}${l.remaining === 3 ? '③' : l.remaining === 2 ? '②' : '①'}`).join('') : '';
  htmlBottom += `<span style="color:#fff;white-space:nowrap;">${name}：工资${salary}${frozenText}${bomingFrozenText}${loanText}</span>`;
  htmlBottom += `</div>`;

  // 第二排：宠物+卡片（宠物在左边）
  htmlBottom += `<div style="display:flex;align-items:center;justify-content:flex-start;gap:8px;font-size:20px;flex-shrink:0;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;touch-action:pan-x;width:100%;" id="tokenCardsRow"><style>#tokenCardsRow::-webkit-scrollbar{display:none;}</style>`;
  if (player) {
    // 宠物图片在卡片排左边
    if (player.petImage) {
      const isCwq = player.petImage && player.petImage.startsWith('cw');
      const petSrc = isCwq ? `/drawable/chongwu/chongwu2/${player.petImage}` : `/drawable/chongwu/${player.petImage}`;
      const opacity = player.petFlipped ? 0.4 : 1;
      const petInfo = getPetInfo(player.petImage);
      const petDesc = petInfo ? `${petInfo.name}：${petInfo.desc}` : (player.petFlipped ? '翻面' : '当前宠物');
      htmlBottom += `<div style="position:relative;display:inline-block;width:40px;height:40px;flex-shrink:0;"><img src="${petSrc}" style="width:40px;height:40px;object-fit:contain;border-radius:4px;opacity:${opacity};cursor:pointer;flex-shrink:0;" class="token-card-img" data-card-name="${petInfo ? petInfo.name : '宠物'}" data-card-desc="${petDesc}">${player.petFlipped ? '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:clamp(12px,2.5vw,16px);font-weight:bold;text-shadow:0 0 4px #000;pointer-events:none;white-space:nowrap;">翻面</div>' : ''}</div>`;
    }
    if (player.cards && player.cards.length > 0) {
      player.cards.forEach((c, i) => {
        const isHiddenSub = c.hiddenType && c.name.startsWith('隐藏卡·');
        const displayName = isHiddenSub ? '隐藏卡' : c.name;
        let displayDesc;
        if (isHiddenSub) {
          displayDesc = '隐藏卡：效果仅卡主可见';
        } else {
          displayDesc = c.description;
        }
        htmlBottom += `<img src="/drawable/kapian/${c.image}.png" style="width:40px;height:40px;object-fit:contain;border-radius:4px;cursor:pointer;flex-shrink:0;" class="token-card-img" data-card-index="${i}" data-card-name="${displayName}" data-card-desc="${displayDesc}">`;
      });
    }
    if (player.extraPets && player.extraPets.length > 0) {
      player.extraPets.forEach(pet => {
        const isCwqPet = pet.startsWith('cw');
        const petSrc = isCwqPet ? `/drawable/chongwu/chongwu2/${pet}` : `/drawable/chongwu/${pet}`;
        const petInfo = getPetInfo(pet);
        const petName = petInfo ? petInfo.name : '宠物';
        const petDesc = petInfo ? `${petInfo.name}：${petInfo.desc}` : '备用宠物';
        htmlBottom += `<img src="${petSrc}" style="width:40px;height:40px;object-fit:contain;border-radius:4px;cursor:pointer;flex-shrink:0;" class="token-card-img" data-card-name="${petName}" data-card-desc="${petDesc}">`;
      });
    }
  }
  htmlBottom += `</div>`;
  
  // 第三排：卡片说明文字
  htmlBottom += `<div style="display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px;line-height:1.2;word-break:break-all;width:100%;" id="tokenCardDesc"></div>`;
  
  htmlBottom += `</div>`;
  
  panelBottom = document.createElement('div');
  panelBottom.id = 'tokenSalaryPanelBottom';
  panelBottom.style.cssText = `position:fixed;left:0;right:0;z-index:50;display:flex;align-items:flex-start;background:#000;color:#fff;overflow:visible;pointer-events:auto;`;
  panelBottom.style.top = actionBarRect.top + 'px';
  panelBottom.style.height = (bottomBarRect.bottom - actionBarRect.top) + 'px';
  panelBottom.innerHTML = htmlBottom;
  
  document.body.appendChild(panelBottom);
  
  panelBottom.querySelectorAll('.token-card-img').forEach(img => {
    img.onclick = (e) => {
      e.stopPropagation();
      const descEl = document.getElementById('tokenCardDesc');
      if (descEl) descEl.textContent = img.dataset.cardDesc || img.dataset.cardName;
    };
  });
  
  const closeBtn = document.getElementById('tokenPanelClose');
  if (closeBtn) {
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      panelTop.remove();
      panelBottom.remove();
    };
  }
};

function adjustPlayerNameFontSize() {
  document.querySelectorAll('.player-card').forEach(card => {
    const nameText = card.querySelector('.player-name-text');
    if (!nameText) return;
    const moneyEl = card.querySelector('.p-money');
    if (!moneyEl) return;
    // M1字号与M2保持一致：读取M2的计算字号并应用到M1
    moneyEl.style.fontSize = '';
    const m2Size = window.getComputedStyle(moneyEl).fontSize;
    nameText.style.fontSize = m2Size;
    const fontSizeNum = parseFloat(m2Size);
    // 角色圈同步缩小
    const circle = card.querySelector('.role-circle-inline');
    if (circle) {
      const cs = window.getComputedStyle(circle);
      circle.style.width = cs.width;
      circle.style.height = cs.height;
    }
  });
}

function handleSpaceClick(space, spaceEl) {
  showPropertyOverlay(space, spaceEl);
}

function renderBoardOnly() {
  const boardEl = $('board');
  const hArea = $('hArea');
  if (hArea) hArea.classList.remove('hidden');
  if (!boardEl) return;
  Array.from(boardEl.children).forEach(child => {
    if (child.classList && child.classList.contains('space')) child.remove();
  });
  boardEl.style.gridTemplateColumns = 'repeat(6, 1fr)';
  boardEl.style.gridTemplateRows = 'repeat(6, 1fr)';

  board.forEach(space => {
    if (space.type === 'jail' && space.name !== '财产罪') return;
    const row = Math.floor(space.id / 6) + 1;
    const col = (space.id % 6) + 1;
    const el = document.createElement('div');
    const isSelectableProp = (qiyuLianyinSelectingProp || qiyuYinhuoDefuSelecting || qiyuAiwuJiwuSelecting || qiyuTudijianbingSelectingProperty || qiyuXiaolicangdaoSelectingProp || (qiyuBanzhuanDarenSelectingProp && space.houseLevel < 4)) && space.isProperty && space.owner === myId;
    const isAnduchengcangProp = qiyuAnduchengcangSelectingProp && space.isProperty && space.owner === window.qiyuAnduchengcangTargetId && window.qiyuAnduchengcangProperties?.some(p => p.id === space.id);
    el.className = `space ${space.type === 'property' ? (space.owner ? 'owned' : 'property') : ''} ${space.closed ? 'closed' : ''} ${isSelectableProp || isAnduchengcangProp ? 'selectable-prop' : ''}`;
    el.dataset.id = space.id;
    el.style.gridRow = row;
    el.style.gridColumn = col;
    if (isSelectableProp || isAnduchengcangProp) {
      el.style.border = '2px solid #fff';
      el.style.cursor = 'pointer';
    }
    
    let ownerColor = null;
    if (space.type === 'property' && space.owner && space.isProperty === true) {
      const owner = players.find(p => p.id === space.owner);
      if (owner) {
        ownerColor = owner.color;
      }
    }

    const here = players.filter(p => { const pos = animatingPositions.has(p.id) ? animatingPositions.get(p.id) : p.position; return pos === space.id && !p.bankrupt && !p.inJail; });
    const current = players[currentPlayerIdx];
    
    let nameRowHtml = `<div class="space-name-row">`;
    nameRowHtml += '<div class="name-row-scroll">';
    const displayName = space.displayName || space.name;
    let houseRoman = '';
    if (ownerColor) {
      const houseLevel = space.houseLevel || 0;
      if (houseLevel === 1) houseRoman = 'Ⅰ';
      else if (houseLevel === 2) houseRoman = 'Ⅱ';
      else if (houseLevel === 3) houseRoman = 'Ⅲ';
      else if (houseLevel === 4) houseRoman = 'Ⅴ';
    }
    let nameSuffix = houseRoman;
    if (space.closed) {
      nameRowHtml += `<div class="space-name closed" style="color:${ownerColor || '#fff'}">${displayName}${nameSuffix}${space.id === 0 ? '→' : ''}</div>`;
    } else {
      nameRowHtml += `<div class="space-name" style="color:${ownerColor || '#fff'}">${displayName}${nameSuffix}${space.id === 0 ? '→' : ''}</div>`;
    }
    nameRowHtml += '</div>';
    nameRowHtml += '</div>';

    let progressLineHtml = '';
    if (space.name === '昆仑' && kunlunPlayerId && kunlunPlayerColor) {
      const pct = (kunlunProgress / 8) * 100;
      progressLineHtml = `<div style="width:100%;height:2px;background:rgba(255,255,255,0.3);position:relative;"><div style="width:${pct}%;height:100%;background:${kunlunPlayerColor};"></div></div>`;
    }
    if (space.type === 'diamond' && diamondCirclePlayerId && diamondCirclePlayerColor) {
      const pct = (diamondCircleProgress / 11) * 100;
      progressLineHtml = `<div style="width:100%;height:2px;background:rgba(255,255,255,0.3);position:relative;"><div style="width:${pct}%;height:100%;background:${diamondCirclePlayerColor};"></div></div>`;
    }
    
    let html = nameRowHtml;
    html += progressLineHtml;
    const tokenImages = [];
    const otherImages = [];
    here.forEach(p => {
      tokenImages.push({ type: 'token', player: p });
    });
    if (window.zhadanState && window.zhadanState.position === space.id) {
      const bombImg = window.zhadanState.turnsLeft === 1 ? 'zhadan1' : 'zhadan2';
      otherImages.push({ src: `/drawable/kapian/${bombImg}.png`, type: 'zhadan', tooltip: true });
    }
    if (window.dayunState && window.dayunState.position === space.id) {
      otherImages.push({ src: '/drawable/ditu/gaitu/dayun.png', type: 'dayun', tooltip: true });
    }
    if (space.id === 1) {
      // 囚牢图形已移到M3区域，不再在格子中显示
    }
    if (luzhangPositions.includes(space.id)) {
      otherImages.push({ src: '/drawable/kapian/luzhang.png', type: 'luzhang', tooltip: true });
    }
    if (cicadaActive && cicadaPosition !== null && cicadaPosition === space.id) {
      otherImages.push({ src: '/drawable/chongwu/chongwu2/cw0.png', type: 'cicada', tooltip: false });
    }
    if (window.houwangPosition !== null && window.houwangPosition === space.id) {
      otherImages.push({ src: '/drawable/chongwu/chongwu2/cw3.png', type: 'houwang', tooltip: false });
    }
    if (window.yingmoPosition !== null && window.yingmoPosition === space.id) {
      otherImages.push({ src: '/drawable/chongwu/chongwu2/cw4.png', type: 'yingmo', tooltip: false });
    }
    const contentImages = [...tokenImages, ...otherImages];
    const totalCount = contentImages.length;
    const visibleCount = totalCount <= 1 ? 1 : (totalCount <= 3 ? totalCount : 3);
    const itemWidth = (100 / visibleCount) + '%';
    const scrollContainerStyle = 'display:flex;flex-direction:row;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;';
    
    const isSelectingMode = selectingChuansongTarget || document.querySelector('.chuansong-selectable') || selectingDayunPlace || document.querySelector('.dayun-place-selectable') || selectingPropertyClosed || selectingPropertyEffect || selectingShanxianTarget || document.querySelector('.shanxian-selectable') || selectingTingyeTarget || qiyuLianyinSelectingProp || qiyuYinhuoDefuSelecting || qiyuAiwuJiwuSelecting || qiyuTudijianbingSelectingProperty || qiyuXiaolicangdaoSelectingProp || qiyuBanzhuanDarenSelectingProp || qiyuAnduchengcangSelectingProp || guoneiLvyouSelecting || zagumaitieSelecting || selectingShunyiTarget || paozhuanSelectingProp || selectingChehuoPos || window.selectingWuzhongshengyouProp || window.selectingGongchengProp || jiaoyiSelectingProp || selectingLuzhangPosition || zibaoSelectingProp || banjiaSelectingSource || banjiaSelectingTarget || dacaoSelectingProp || qiangmaiSelectingProp || selectingPetShopEmptyProp || selectingWhiteBorderProperty;
    
    const isSelectingPropertyMode = selectingChuansongTarget || selectingDayunPlace || selectingPropertyClosed || selectingPropertyEffect || selectingShanxianTarget || selectingTingyeTarget || qiyuLianyinSelectingProp || qiyuYinhuoDefuSelecting || qiyuAiwuJiwuSelecting || qiyuTudijianbingSelectingProperty || qiyuXiaolicangdaoSelectingProp || qiyuBanzhuanDarenSelectingProp || qiyuAnduchengcangSelectingProp || guoneiLvyouSelecting || zagumaitieSelecting || selectingShunyiTarget || paozhuanSelectingProp || selectingChehuoPos || window.selectingWuzhongshengyouProp || window.selectingGongchengProp || jiaoyiSelectingProp || document.querySelector('.chuansong-selectable') || document.querySelector('.dayun-place-selectable') || document.querySelector('.shanxian-selectable') || selectingLuzhangPosition || zibaoSelectingProp || banjiaSelectingSource || banjiaSelectingTarget || dacaoSelectingProp || qiangmaiSelectingProp || selectingPetShopEmptyProp || selectingWhiteBorderProperty;
    
    html += `<div class="space-content" style="position:relative;">`;
    const selectingLayout = isSelectingMode ? 'display:flex;flex-wrap:wrap;align-items:center;justify-content:center;' : scrollContainerStyle;
    html += `<div style="position:absolute;top:0;left:0;right:0;bottom:0;${selectingLayout}">`;

    for (let i = 0; i < contentImages.length; i++) {
      const img = contentImages[i];
      if (img.type === 'token') {
        const p = img.player;
        if (isSelectingPropertyMode || isSelectingMode) {
          // 白框选择模式：保持角色原图片
          html += `<div style="flex:0 0 33.33%;height:50%;display:flex;align-items:center;justify-content:center;"><img class="token-img" src="/drawable/juese/${p.character}${p.variant || '2'}.png" data-player-id="${p.id}"></div>`;
        } else {
          html += `<div style="flex:0 0 ${itemWidth};height:100%;display:flex;align-items:center;justify-content:center;"><img class="token-img token-clickable" src="/drawable/juese/${p.character}${p.variant || '2'}.png" data-player-id="${p.id}" data-character="${p.character}" data-variant="${p.variant || '2'}" data-name="${p.name.replace(/"/g, '&quot;')}" data-color="${p.color}" data-salary="${p.salary}"></div>`;
        }
      } else if (img.type === 'jailBars') {
        // 囚牢图形已移到M3区域，不再在格子中渲染
      } else {
        if (isSelectingMode) continue; // 白框选择模式隐藏非角色图片
        const cursorStyle = img.tooltip ? 'cursor:pointer;' : '';
        let clickHandler = '';
        if (img.type === 'zhadan') {
          clickHandler = 'onclick="event.stopPropagation();showZhadanTooltip(event)"';
        } else if (img.type === 'dayun') {
          clickHandler = 'onclick="event.stopPropagation();showDayunTooltip(event)"';
        } else if (img.type === 'luzhang') {
          clickHandler = 'onclick="event.stopPropagation();showLuzhangTooltip(event)"';
        }
        html += `<div style="flex:0 0 ${itemWidth};height:100%;display:flex;align-items:center;justify-content:center;"><img src="${img.src}" style="max-width:100%;height:100%;${cursorStyle}object-fit:contain;" ${clickHandler}></div>`;
      }
    }

    html += '</div>';

    html += '</div>';
    
    el.innerHTML = html;
    
    el.style.cursor = 'pointer';
    el.onclick = (e) => {
      const isSelectingMode = selectingChuansongTarget || !!document.querySelector('.chuansong-selectable') || selectingDayunPlace || !!document.querySelector('.dayun-place-selectable') || selectingPropertyClosed || selectingPropertyEffect || selectingShanxianTarget || !!document.querySelector('.shanxian-selectable') || selectingTingyeTarget || qiyuLianyinSelectingProp || qiyuYinhuoDefuSelecting || qiyuAiwuJiwuSelecting || qiyuTudijianbingSelectingProperty || qiyuXiaolicangdaoSelectingProp || qiyuBanzhuanDarenSelectingProp || qiyuAnduchengcangSelectingProp || guoneiLvyouSelecting || zagumaitieSelecting || selectingShunyiTarget || paozhuanSelectingProp || selectingChehuoPos || !!window.selectingWuzhongshengyouProp || !!window.selectingGongchengProp || jiaoyiSelectingProp || selectingLuzhangPosition || zibaoSelectingProp || banjiaSelectingSource || banjiaSelectingTarget || dacaoSelectingProp || qiangmaiSelectingProp || selectingPetShopEmptyProp || selectingWhiteBorderProperty;
      
      if (isSelectingMode) {
        if (qiyuLianyinSelectingProp && space.isProperty && space.owner === myId) {
          socket.emit('qiyuLianyinProp', { propId: space.id });
          return;
        }
        if (qiyuYinhuoDefuSelecting && space.isProperty && space.owner === myId) {
          selectQiyuYinhuoDefuProp(space.id);
          return;
        }
        if (qiyuAiwuJiwuSelecting && space.isProperty && space.owner === myId) {
          qiyuAiwuJiwuSelecting = false;
          socket.emit('qiyuAiwuJiwuSelect', { propertyId: space.id });
          render();
          return;
        }
        if (qiyuTudijianbingSelectingProperty && space.isProperty && space.owner === myId) {
          qiyuTudijianbingSelectingProperty = false;
          socket.emit('qiyuTudijianbingSelectProperty', { propertyId: space.id });
          render();
          return;
        }
        if (qiyuXiaolicangdaoSelectingProp && space.isProperty && space.owner === myId) {
          qiyuXiaolicangdaoSelectingProp = false;
          socket.emit('qiyuXiaolicangdaoSelectProp', { propertyId: space.id });
          render();
          return;
        }
        if (qiyuBanzhuanDarenSelectingProp && space.isProperty && space.owner === myId && space.houseLevel < 4) {
          qiyuBanzhuanDarenSelectingProp = false;
          socket.emit('qiyuBanzhuanDarenConfirm', { propertyId: space.id });
          render();
          return;
        }
        if (qiyuAnduchengcangSelectingProp && space.isProperty && space.owner === window.qiyuAnduchengcangTargetId && window.qiyuAnduchengcangProperties?.some(p => p.id === space.id)) {
          qiyuAnduchengcangSelectingProp = false;
          socket.emit('qiyuAnduchengcangPropChoice', { propertyId: space.id });
          render();
          return;
        }
        if (selectingChuansongTarget || document.querySelector('.chuansong-selectable')) {
          selectingChuansongTarget = false;
          socket.emit('chuansongSelect', { spaceId: space.id });
          document.querySelectorAll('.chuansong-selectable').forEach(s => {
            s.style.outline = '';
            s.style.cursor = '';
            s.classList.remove('chuansong-selectable');
          });
          return;
        }
        if (selectingShanxianTarget || document.querySelector('.shanxian-selectable')) {
          const el2 = e.currentTarget;
          if (el2 && el2.classList.contains('shanxian-selectable')) {
            selectingShanxianTarget = false;
            socket.emit('shanxianSelect', { spaceId: space.id });
            document.querySelectorAll('.shanxian-selectable').forEach(s => {
              s.style.outline = '';
              s.style.cursor = '';
              s.classList.remove('shanxian-selectable');
            });
            return;
          }
        }
        if (selectingDayunPlace && [5, 11, 17, 23, 29, 35].includes(space.id)) {
          socket.emit('dayunPlace', { spaceId: space.id });
          selectingDayunPlace = false;
          document.querySelectorAll('.dayun-place-selectable').forEach(s => {
            s.style.outline = '';
            s.classList.remove('dayun-place-selectable');
          });
          return;
        }
        if (selectingPropertyClosed && space.isProperty && space.owner !== null) {
          socket.emit('sansiPropertyClosed', { propertyId: space.id });
          selectingPropertyClosed = false;
          document.querySelectorAll('.property-closed-selectable').forEach(s => {
            s.style.outline = '';
            s.style.cursor = 'pointer';
            s.classList.remove('property-closed-selectable');
          });
          return;
        }
        if (selectingPropertyEffect && space.isProperty && space.owner === myId) {
          socket.emit('sansiPropertyEffect', { propertyId: space.id });
          selectingPropertyEffect = false;
          document.querySelectorAll('.property-effect-selectable').forEach(s => {
            s.style.outline = '';
            s.style.cursor = 'pointer';
            s.classList.remove('property-effect-selectable');
          });
          return;
        }
        if (guoneiLvyouSelecting && [8, 9, 10].includes(space.id)) {
          guoneiLvyouSelecting = false;
          socket.emit('guoneiLvyouSelect', { spaceId: space.id });
          document.querySelectorAll('.guonei-lvyou-selectable').forEach(s => {
            s.style.outline = '';
            s.style.cursor = 'pointer';
            s.classList.remove('guonei-lvyou-selectable');
          });
          return;
        }
        if (zagumaitieSelecting) {
          const clickedSpace = board.find(s => s.id === space.id);
          if (clickedSpace && clickedSpace.isProperty && clickedSpace.owner === myId) {
            zagumaitieSelecting = false;
            socket.emit('zagumaitieSelectProperty', { spaceId: space.id });
            document.querySelectorAll('.zagumaitie-selectable').forEach(s => {
              s.style.outline = '';
              s.style.cursor = 'pointer';
              s.classList.remove('zagumaitie-selectable');
            });
            return;
          }
        }
        if (window.selectingWuzhongshengyouProp && space.isProperty && space.owner === myId) {
          window.selectingWuzhongshengyouProp = false;
          socket.emit('wuzhongshengyouSelectProp', { propId: space.id });
          document.querySelectorAll('.wuzhongshengyou-selectable').forEach(s => {
            s.style.outline = '';
            s.style.cursor = 'pointer';
            s.classList.remove('wuzhongshengyou-selectable');
          });
          return;
        }
        if (window.selectingGongchengProp && space.isProperty && space.owner !== myId && space.houseLevel > 0) {
          window.selectingGongchengProp = false;
          socket.emit('gongchengSelectTarget', { propId: space.id });
          document.querySelectorAll('.gongcheng-selectable').forEach(s => {
            s.style.outline = '';
            s.style.cursor = 'pointer';
            s.classList.remove('gongcheng-selectable');
          });
          return;
        }
        return;
      }
      if (e.target.closest('.space-name')) {
        handleSpaceClick(space, el);
        return;
      }
    };
    
    boardEl.appendChild(el);
  });

  if (selectingPropertyEffect) {
    document.querySelectorAll('.space').forEach(spaceEl => {
      const spaceId = parseInt(spaceEl.dataset.id);
      const space = board.find(s => s.id === spaceId);
      if (space && space.isProperty && space.owner === myId) {
        spaceEl.style.outline = '2px solid #fff'; spaceEl.style.outlineOffset = '-2px';
        spaceEl.style.cursor = 'pointer';
        spaceEl.classList.add('property-effect-selectable');
      }
    });
  }
  if (selectingPropertyClosed) {
    document.querySelectorAll('.space').forEach(spaceEl => {
      const spaceId = parseInt(spaceEl.dataset.id);
      const space = board.find(s => s.id === spaceId);
      if (space && space.isProperty && space.owner !== null) {
        spaceEl.style.outline = '2px solid #fff'; spaceEl.style.outlineOffset = '-2px';
        spaceEl.style.cursor = 'pointer';
        spaceEl.classList.add('property-closed-selectable');
      }
    });
  }
  if (selectingDayunPlace) {
    const dayunAllowedIds = [5, 11, 17, 23, 29, 35];
    document.querySelectorAll('.space').forEach(spaceEl => {
      const spaceId = parseInt(spaceEl.dataset.id);
      if (dayunAllowedIds.includes(spaceId)) {
        spaceEl.style.outline = '2px solid #fff'; spaceEl.style.outlineOffset = '-2px';
        spaceEl.style.cursor = 'pointer';
        spaceEl.classList.add('dayun-place-selectable');
      }
    });
  }
  if (guoneiLvyouSelecting) {
    const guoneiAllowedIds = [8, 9, 10];
    document.querySelectorAll('.space').forEach(spaceEl => {
      const spaceId = parseInt(spaceEl.dataset.id);
      if (guoneiAllowedIds.includes(spaceId)) {
        spaceEl.style.outline = '2px solid #fff'; spaceEl.style.outlineOffset = '-2px';
        spaceEl.style.cursor = 'pointer';
        spaceEl.classList.add('guonei-lvyou-selectable');
      }
    });
  }
  if (zagumaitieSelecting) {
    document.querySelectorAll('.space').forEach(spaceEl => {
      const spaceId = parseInt(spaceEl.dataset.id);
      const space = board.find(s => s.id === spaceId);
      if (space && space.isProperty && space.owner === myId) {
        spaceEl.style.outline = '2px solid #fff'; spaceEl.style.outlineOffset = '-2px';
        spaceEl.style.cursor = 'pointer';
        spaceEl.classList.add('zagumaitie-selectable');
      }
    });
  }
  if (window.selectingWuzhongshengyouProp) {
    document.querySelectorAll('.space').forEach(spaceEl => {
      const spaceId = parseInt(spaceEl.dataset.id);
      const space = board.find(s => s.id === spaceId);
      if (space && space.isProperty && space.owner === myId) {
        spaceEl.style.outline = '2px solid #fff'; spaceEl.style.outlineOffset = '-2px';
        spaceEl.style.cursor = 'pointer';
        spaceEl.classList.add('wuzhongshengyou-selectable');
      }
    });
  }
  if (window.selectingGongchengProp) {
    document.querySelectorAll('.space').forEach(spaceEl => {
      const spaceId = parseInt(spaceEl.dataset.id);
      const space = board.find(s => s.id === spaceId);
      if (space && space.isProperty && space.owner !== myId && space.houseLevel > 0) {
        spaceEl.style.outline = '2px solid #fff'; spaceEl.style.outlineOffset = '-2px';
        spaceEl.style.cursor = 'pointer';
        spaceEl.classList.add('gongcheng-selectable');
      }
    });
  }

  refreshPlayerCards();
  adjustPlayerNameFontSize();
  initTokenClick();
  
  const me = players.find(p => p.id === myId);
  if (me) {
    const areaD = $('areaD');
    if (areaD) {
      const hasCards = (me.cards && me.cards.length > 0) || (me.extraPets && me.extraPets.length > 0) || me.petImage;
      if (hasCards) {
        areaD.innerHTML = `<img src="/drawable/kapian.png" style="width:100%;height:100%;object-fit:contain;cursor:pointer;" onclick="showCardPackPanel()">`;
      } else {
        areaD.innerHTML = '';
      }
    }
  }

  if (!fixedCwq) {
    const cwq = ['cw1.png','cw2.png','cw3.png','cw4.png','cw5.png','cw6.png'];
    fixedCwq = cwq[Math.floor(Math.random()*cwq.length)];
  }
  const meForC = players.find(p => p.id === myId);

  if (flyTargetHighlight) {
    document.querySelectorAll('.space').forEach(spaceEl => {
      const spaceId = parseInt(spaceEl.dataset.id);
      if (flyTargetHighlight.includes(spaceId)) {
        spaceEl.style.border = '3px solid yellow';
        spaceEl.style.cursor = 'pointer';
        spaceEl.onclick = () => {
          flyTargetHighlight = null;
          document.querySelectorAll('.space').forEach(s => {
            s.style.border = '';
            s.style.cursor = '';
            s.onclick = null;
          });
          $('areaE').innerHTML = '';
          socket.emit('sansiFlyTarget', { targetPos: spaceId });
        };
      }
    });
  }
}

function render() {
  console.log('[DEBUG] render called, currentPlayerIdx:', currentPlayerIdx, 'myId:', myId, 'players.len:', players?.length, 'curId:', players?.[currentPlayerIdx]?.id, 'isMyTurn:', players?.[currentPlayerIdx]?.id === myId, 'showThinkingOnce:', showThinkingOnce, 'diceValue:', currentDiceValue);
  const anyInJail = players.some(p => p.inJail && !p.bankrupt);
  if (!anyInJail) {
    isJailMap = false;
    jailMinimized = false;
    const existingPanel = document.querySelector('.jail-panel');
    if (existingPanel) existingPanel.remove();
  }
  
  renderBoardOnly();
  restoreMoneyIndicators();
  reattachSansiPanel();

  const cur = players[currentPlayerIdx];
  const isMyTurn = cur?.id === myId && !cur?.bankrupt;

  if (cur?.inJail && cur?.jailState === 'justJailed' && !awaitingGoToJail) {
    if (!message) {
      $('areaE').innerHTML = `${coloredName(cur.name, cur.color)}巨额财产来源不明罪，进监狱`;
    }
    if (isMyTurn) {
      socket.emit('confirmGoToJail');
    } else {
      if ($j('jailActions')) $j('jailActions').classList.add('hidden');
    }
  } else if (cur?.inJail && cur?.jailState === 'leaving') {
  } else if (!isJailMap && !chuanxiaoPinqianActive && !hasClickedJudge && !selectingHezongTarget && !waitingHezongTarget && !qiyuNilaiWangwangSelecting && !qiyuMeirenjiSelecting && !qiyuTudijianbingSelectingTarget && showThinkingOnce && tckQueue.length === 0 && tipQueue.length === 0) {
    if (!lastAreaEMessage) {
      $('areaE').innerHTML = `${coloredName(cur?.name || '-', cur?.color || '#fff')}正在思考...`;
      fitAreaEText();
    }
    showThinkingOnce = false;
    if ($j('jailActions')) {
      $j('jailActions').classList.add('hidden');
      $j('jailActions').innerHTML = '';
    }
    updateGAreaDiceImage(currentDiceValue, isMyTurn);
    if (document.getElementById('areaF')) {
      document.getElementById('areaF').innerHTML = '';
    }
  } else if (!isJailMap && !chuanxiaoPinqianActive && !hasClickedJudge && !selectingHezongTarget && !waitingHezongTarget) {
    updateGAreaDiceImage(currentDiceValue, isMyTurn);
  } else {
  }
}

function renderJailTokens(playersInCell) {
  let html = '<div class="jail-tokens-row">';
  
  playersInCell.forEach(p => {
    html += `<img class="jail-token-img jail-token-clickable" src="/drawable/juese/${p.character}${p.variant || '2'}.png" data-player-id="${p.id}" data-character="${p.character}" data-variant="${p.variant || '2'}" data-name="${p.name.replace(/"/g, '&quot;')}" data-color="${p.color}" data-salary="${p.salary}" style="cursor:pointer;">`;
  });
  
  html += '</div>';
  return html;
}

// Function kept for compatibility, but rollBtn has been moved to G area
function updateRollButtonState() {
  // No longer needed, roll button functionality moved to G area
}

let hasShownJudgeBailOptions = false;
let lastCurrentPlayerIdx = -1;

function showJailPanel() {
  jailMinimized = false;
  const existingPanel = document.querySelector('.jail-panel');
  if (existingPanel) existingPanel.remove();
  const jailedPlayers = players.filter(p => p.inJail && !p.bankrupt);
  buildJailPanel(jailedPlayers);
}

function buildJailPanel(jailedPlayers) {
  const jailPanel = document.createElement('div');
  jailPanel.className = 'jail-panel';
  let jailCellsHTML = '';
  const cellOrder = ['island', 'jail', 'hospital', 'health'];
  const cellLabels = { island: '海南', jail: '监狱', hospital: '医院', health: '健康' };
  const cellPositions = {
    island: 'grid-column: 1 / 3; grid-row: 1;',
    jail: 'grid-column: 1 / 3; grid-row: 2;',
    hospital: 'grid-column: 1; grid-row: 3;',
    health: 'grid-column: 2; grid-row: 3;'
  };
  const yingmoCellMap = { 37: 'island', 38: 'hospital', 39: 'jail', 40: 'health' };
  const yingmoCell = window.yingmoPosition !== null ? yingmoCellMap[window.yingmoPosition] : null;
  cellOrder.forEach(cell => {
    const playersInCell = jailedPlayers.filter(p => {
      const state = ['justJailed'].includes(p.jailState) ? 'jail' : p.jailState;
      return state === cell;
    });
    const isActive = playersInCell.length > 0 || yingmoCell === cell;
    let tokens = renderJailTokens(playersInCell);
    if (yingmoCell === cell) {
      tokens += `<img class="jail-yingmo-img" src="/drawable/chongwu/chongwu2/cw4.png" style="width:24px;height:24px;object-fit:contain;margin-left:2px;vertical-align:middle;" title="影魔">`;
    }
    jailCellsHTML += `<div class="jail-cell ${cell} ${isActive ? 'active' : ''}" style="${cellPositions[cell]}"><span style="font-size:14px;">${cellLabels[cell]}</span>${tokens}</div>`;
  });
  jailPanel.innerHTML = `
    <div class="jail-header">
      <span class="jail-title" style="font-size:16px;color:#fff;">放逐区</span>
      <button id="jailMinBtn" class="jail-min-btn">─</button>
    </div>
    <div class="jail-body">
      <div class="jail-grid-wrapper">
        <div class="jail-grid">
          ${jailCellsHTML}
        </div>
        <svg class="jail-path-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          <line x1="50" y1="42" x2="50" y2="24" stroke="#888" stroke-width="0.5"/>
          <polygon points="48,24 52,24 50,19" fill="#888"/>
          <text x="50" y="36" text-anchor="middle" fill="#fff" font-size="5" font-weight="bold">1</text>
          <line x1="25" y1="50" x2="25" y2="76" stroke="#888" stroke-width="0.5"/>
          <polygon points="23,76 27,76 25,81" fill="#888"/>
          <text x="25" y="67" text-anchor="middle" fill="#fff" font-size="5" font-weight="bold">2-5</text>
          <line x1="75" y1="50" x2="75" y2="76" stroke="#888" stroke-width="0.5"/>
          <polygon points="73,76 77,76 75,81" fill="#888"/>
          <text x="75" y="67" text-anchor="middle" fill="#fff" font-size="5" font-weight="bold">$8</text>
          <line x1="40" y1="87" x2="55" y2="87" stroke="#888" stroke-width="0.5"/>
          <polygon points="55,84 55,90 60,87" fill="#888"/>
        </svg>
      </div>
    </div>
  `;
  const boardArea = $('hArea');
  if (boardArea) {
    boardArea.style.position = 'relative';
    boardArea.appendChild(jailPanel);
    jailPanel.style.position = 'absolute';
    jailPanel.style.top = '50%';
    jailPanel.style.left = '50%';
    jailPanel.style.transform = 'translate(-50%, -50%)';
  }
  const minBtn = $('jailMinBtn');
  initJailDrag(jailPanel);
  
  jailPanel.querySelectorAll('.jail-token-clickable').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const playerId = el.dataset.playerId;
      const character = el.dataset.character;
      const variant = el.dataset.variant;
      const name = el.dataset.name;
      const color = el.dataset.color;
      const salary = el.dataset.salary;
      window.showTokenSalary(playerId, character, variant, name, color, salary);
    };
  });

  let minBtnDragged = false;
  minBtn.addEventListener('mousedown', (e) => {
    if (jailMinimized) return;
    e.stopPropagation();
    e.preventDefault();
    minBtnDragged = false;
    const onMove = () => { minBtnDragged = true; };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!minBtnDragged) {
        e.stopPropagation();
        e.preventDefault();
        toggleJailMinimize();
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  minBtn.addEventListener('touchstart', (e) => {
    if (jailMinimized) return;
    e.stopPropagation();
    e.preventDefault();
    minBtnDragged = false;
    const onMove = () => { minBtnDragged = true; };
    const onEnd = () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      if (!minBtnDragged) {
        e.stopPropagation();
        e.preventDefault();
        toggleJailMinimize();
      }
    };
    document.addEventListener('touchmove', onMove);
    document.addEventListener('touchend', onEnd);
  });
}

function renderWithJailPanel(message, showActions = true) {
  const cur = players[currentPlayerIdx];
  const jailedPlayers = players.filter(p => p.inJail && !p.bankrupt);
  const jailState = cur?.inJail ? (cur?.jailState || 'choice') : (jailedPlayers.length > 0 ? jailedPlayers[0].jailState : 'choice');
  const isMyTurn = cur?.id === myId && !cur?.bankrupt;
  const curInJail = cur?.inJail;

  renderBoardOnly();
  initTokenClick();
  // 设置 E 区消息
  if (message) {
    $('areaE').innerHTML = message;
    fitAreaEText();
  } else if (!selectingHezongTarget && !waitingHezongTarget && showThinkingOnce) {
    $('areaE').innerHTML = `${coloredName(cur?.name || '-', cur?.color || '#fff')}正在思考...`;
    fitAreaEText();
    showThinkingOnce = false;
  }

  // 确保 jailActions 元素被隐藏
  const jailActionsEl = $j('jailActions');
  if (jailActionsEl) {
    jailActionsEl.classList.add('hidden');
    jailActionsEl.innerHTML = '';
  }

// 玩家在监狱区域且是自己回合
  const currentTile = board[cur?.position];
  const isJailTile = currentTile && ['jail', 'health', 'hospital', 'island'].includes(currentTile.type);

  if (curInJail) {
    if (jailState === 'justJailed' || jailState === 'choice') {
      if (isMyTurn && showActions) {
        if (!message) {
          $('areaE').innerHTML = message || `${coloredName(cur.name, cur.color)}在监狱`;
        }
        document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
        const endTurnBtn = document.getElementById('endTurnBtn');
        if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
      } else if (showActions) {
        document.getElementById('areaF').innerHTML = '';
      }
    } else if (jailState === 'jail') {
      if (isMyTurn && !hasShownJudgeBailOptions && showActions) {
        document.getElementById('areaF').innerHTML = '<button id="judgeBtn" class="jail-btn">判定</button><button id="bailBtn" class="jail-btn">保释$8</button>';
        const newJudgeBtn = document.getElementById('judgeBtn');
        const newBailBtn = document.getElementById('bailBtn');
        if (newJudgeBtn) {
          newJudgeBtn.onclick = function() {
            hasClickedJudge = true;
            hasShownJudgeBailOptions = true;
            socket.emit('judgeJail');
          };
        }
        if (newBailBtn) {
          newBailBtn.onclick = function() {
            hasClickedJudge = true;
            hasShownJudgeBailOptions = true;
            socket.emit('bailJail');
          };
        }
      } else if (isMyTurn && hasShownJudgeBailOptions && showActions) {
        document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
        const endTurnBtn = document.getElementById('endTurnBtn');
        if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
      } else if (showActions) {
        document.getElementById('areaF').innerHTML = '';
      }
    } else if (jailState === 'island') {
      if (isMyTurn) {
        document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
        const endTurnBtn = document.getElementById('endTurnBtn');
        if (endTurnBtn) {
          endTurnBtn.onclick = () => {
            doEndTurn();
          };
        }
      } else if (!treasureClosePending) {
        document.getElementById('areaF').innerHTML = '';
      }
    } else if (jailState === 'hospital') {
      if (isMyTurn) {
        document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
        const endTurnBtn = document.getElementById('endTurnBtn');
        if (endTurnBtn) {
          endTurnBtn.onclick = () => {
            doEndTurn();
          };
        }
      } else {
        document.getElementById('areaF').innerHTML = '';
      }
    } else if (jailState === 'health') {
      if (isMyTurn) {
        if (message) {
          $('areaE').innerHTML = message;
        } else {
          $('areaE').innerHTML = `${coloredName(cur.name, cur.color)}出狱`;
        }
        document.getElementById('areaF').innerHTML = '<button id="endTurnBtn" class="jail-btn">结束</button>';
        const endTurnBtn = document.getElementById('endTurnBtn');
        if (endTurnBtn) endTurnBtn.onclick = () => doEndTurn();
      } else {
        document.getElementById('areaF').innerHTML = '';
      }
    }
  }
  if (jailedPlayers.length > 0) {
    let jailPanel = document.querySelector('.jail-panel');
    if (!jailPanel) {
      buildJailPanel(jailedPlayers);
      jailPanel = document.querySelector('.jail-panel');
    } else {
      const activeCell = ['island', 'hospital', 'jail', 'health'].includes(jailState) ? jailState : (['justJailed'].includes(jailState) ? 'jail' : null);
      if (!jailMinimized) {
        jailPanel.style.display = '';
        jailPanel.classList.remove('minimized');
        const body = jailPanel.querySelector('.jail-body');
        if (body) body.style.display = '';
        const title = jailPanel.querySelector('.jail-title');
        if (title) title.style.display = '';
        const minBtn = jailPanel.querySelector('.jail-min-btn');
        if (minBtn) minBtn.textContent = '─';
        jailPanel.style.width = '';
        jailPanel.style.height = '';
      }
      updateJailPanel(jailPanel, activeCell);
    }
  }
}

function updateJailPanel(panel, activeCell, jailPlayerColor) {
  const cells = panel.querySelectorAll('.jail-cell');
  const jailedPlayers = players.filter(p => p.inJail && !p.bankrupt);
  const cellOrder = ['island', 'jail', 'hospital', 'health'];
  const yingmoCellMap = { 37: 'island', 38: 'hospital', 39: 'jail', 40: 'health' };
  const yingmoCell = window.yingmoPosition !== null ? yingmoCellMap[window.yingmoPosition] : null;
  cells.forEach(cell => {
    cell.querySelectorAll('.jail-tokens-row, .jail-yingmo-img').forEach(t => t.remove());
    const cellType = cellOrder.find(c => cell.classList.contains(c));
    if (cellType) {
      const playersInCell = jailedPlayers.filter(p => {
        const state = ['justJailed'].includes(p.jailState) ? 'jail' : p.jailState;
        return state === cellType;
      });
      const hasYingmo = yingmoCell === cellType;
      cell.classList.toggle('active', playersInCell.length > 0 || hasYingmo);
      const tokens = renderJailTokens(playersInCell);
      if (tokens) cell.insertAdjacentHTML('beforeend', tokens);
      if (hasYingmo) {
        cell.insertAdjacentHTML('beforeend', '<img class="jail-yingmo-img" src="/drawable/chongwu/chongwu2/cw4.png" style="width:24px;height:24px;object-fit:contain;margin-left:2px;vertical-align:middle;" title="影魔">');
      }
    } else {
      cell.classList.remove('active');
    }
  });
  
  panel.querySelectorAll('.jail-token-clickable').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const playerId = el.dataset.playerId;
      const character = el.dataset.character;
      const variant = el.dataset.variant;
      const name = el.dataset.name;
      const color = el.dataset.color;
      const salary = el.dataset.salary;
      window.showTokenSalary(playerId, character, variant, name, color, salary);
    };
  });
}

function initJailDrag(panel) {
  panel.addEventListener('mousedown', startDrag);
  panel.addEventListener('touchstart', startDrag, { passive: false });
}

function startDrag(e) {
  if (e.target.classList.contains('jail-min-btn') && !jailMinimized) return;
  if (e.target.classList.contains('jail-restore-btn')) return;
  const panel = document.querySelector('.jail-panel');
  if (!panel) return;
  e.preventDefault();
  jailDrag.active = true;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const rect = panel.getBoundingClientRect();
  jailDrag.offsetX = clientX - rect.left;
  jailDrag.offsetY = clientY - rect.top;
  panel.style.position = 'fixed';
  panel.style.zIndex = '1000';
  panel.style.left = rect.left + 'px';
  panel.style.top = rect.top + 'px';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  panel.style.transform = 'none';

  document.addEventListener('mousemove', onDrag);
  document.addEventListener('touchmove', onDrag, { passive: false });
  document.addEventListener('mouseup', stopDrag);
  document.addEventListener('touchend', stopDrag);
}

function onDrag(e) {
  if (!jailDrag.active) return;
  e.preventDefault();
  const panel = document.querySelector('.jail-panel');
  if (!panel) return;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  panel.style.left = (clientX - jailDrag.offsetX) + 'px';
  panel.style.top = (clientY - jailDrag.offsetY) + 'px';
}

function stopDrag() {
  jailDrag.active = false;
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('touchmove', onDrag);
  document.removeEventListener('mouseup', stopDrag);
  document.removeEventListener('touchend', stopDrag);
}

function toggleJailMinimize() {
  const panel = document.querySelector('.jail-panel');
  if (!panel) return;

  if (jailMinimized) {
    jailMinimized = false;
    panel.style.display = '';
    panel.classList.remove('minimized');
    panel.querySelector('.jail-body').style.display = '';
    panel.querySelector('.jail-title').style.display = '';
    panel.querySelector('.jail-min-btn').textContent = '─';
    panel.style.width = '';
    panel.style.height = '';
  } else {
    jailMinimized = true;
    panel.style.display = 'none';
  }
}

function initTokenClick() {
  const isSelectingMode = () => selectingChuansongTarget || document.querySelector('.chuansong-selectable') || selectingDayunPlace || document.querySelector('.dayun-place-selectable') || selectingPropertyClosed || selectingPropertyEffect || selectingShanxianTarget || document.querySelector('.shanxian-selectable') || selectingTingyeTarget || qiyuLianyinSelectingProp || qiyuYinhuoDefuSelecting || qiyuAiwuJiwuSelecting || qiyuTudijianbingSelectingProperty || qiyuXiaolicangdaoSelectingProp || qiyuBanzhuanDarenSelectingProp || qiyuAnduchengcangSelectingProp || guoneiLvyouSelecting || zagumaitieSelecting || selectingShunyiTarget || paozhuanSelectingProp || selectingChehuoPos || window.selectingWuzhongshengyouProp || window.selectingGongchengProp || jiaoyiSelectingProp || selectingLuzhangPosition || zibaoSelectingProp || banjiaSelectingSource || banjiaSelectingTarget || dacaoSelectingProp || qiangmaiSelectingProp || selectingPetShopEmptyProp || selectingWhiteBorderProperty;
  
  document.querySelectorAll('.token-clickable').forEach(el => {
    // 不再响应点击显示棋子面板，改为点击角色信息区(M1-3)
  });
  
  document.querySelectorAll('.name-dot-clickable').forEach(el => {
    el.onclick = (e) => {
      if (isSelectingMode()) {
        return;
      }
      e.stopPropagation();
      const playerId = el.dataset.playerId;
      const character = el.dataset.character;
      const variant = el.dataset.variant;
      const name = el.dataset.name;
      const color = el.dataset.color;
      const salary = el.dataset.salary;
      window.showTokenSalary(playerId, character, variant, name, color, salary);
    };
  });
  
  document.querySelectorAll('.jail-dz-clickable').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const panel = document.querySelector('.jail-panel');
      if (jailMinimized && panel) {
        jailMinimized = false;
        panel.style.display = '';
        panel.classList.remove('minimized');
        panel.querySelector('.jail-body').style.display = '';
        panel.querySelector('.jail-title').style.display = '';
        const minBtn = panel.querySelector('.jail-min-btn');
        if (minBtn) minBtn.textContent = '─';
        panel.style.width = '';
        panel.style.height = '';
      } else if (!panel) {
        const jailedPlayers = players.filter(p => p.inJail && !p.bankrupt);
        if (jailedPlayers.length > 0) {
          isJailMap = true;
          jailMinimized = false;
          renderWithJailPanel(null, false);
        }
      } else {
      }
    };
  });
  initDiamondTooltip();
}

function initDiamondTooltip() {
  document.querySelectorAll('.diamond-icon, .diamond-card, .diamond-thumb').forEach(el => {
    el.onclick = showDiamondTooltip;
  });
  document.querySelectorAll('.m3-status-icon').forEach(el => {
    el.onclick = showStatusTooltip;
  });
}

function showStatusTooltip(e) {
  e.stopPropagation();
  const target = e.currentTarget;
  const text = target.dataset.tooltip || '';
  const imgSrc = target.tagName === 'IMG' ? target.src : null;
  const emoji = target.tagName === 'SPAN' ? target.textContent : null;
  
  let html = '';
  if (imgSrc) {
    html += `<img src="${imgSrc}" style="width:clamp(80px,20vw,130px);height:clamp(80px,20vw,130px);object-fit:contain;flex-shrink:0;">`;
  } else if (emoji) {
    html += `<span style="font-size:60px;flex-shrink:0;">${emoji}</span>`;
  }
  if (text) {
    html += `<span>${text}</span>`;
  }
  showPopupMessage(html);
}

function hideStatusTooltip() {
}

function showRestTooltip(e) {
  showStatusTooltip(e);
}

function hideRestTooltip() {
  clearPopupMessages();
}

function showShelteredTooltip(e) {
  showStatusTooltip(e);
}

function hideShelteredTooltip() {
}

window.showDayunTooltip = function(e) {
  if (e) e.stopPropagation();
  showPopupMessage(`<img src="/drawable/ditu/gaitu/dayun.png" style="width:clamp(80px,20vw,130px);height:clamp(80px,20vw,130px);object-fit:contain;flex-shrink:0;"><span>大运车：下回合开始自动移动1-6步，经过的人-4并休息1回合，到达的人-8进医院</span>`);
}

function hideDayunTooltip() {
}

window.showZhadanTooltip = function(e) {
  if (e) e.stopPropagation();
  showPopupMessage(`<img src="/drawable/kapian/zhadan.png" style="width:clamp(80px,20vw,130px);height:clamp(80px,20vw,130px);object-fit:contain;flex-shrink:0;"><span>炸弹卡：在脚下放置2回合的延时炸弹，踩中-24并进医院，本排的人-4并休息1回合</span>`);
}

function hideZhadanTooltip() {
}

window.showLuzhangTooltip = function(e) {
  if (e) e.stopPropagation();
  showPopupMessage(`<img src="/drawable/kapian/luzhang.png" style="width:clamp(80px,20vw,130px);height:clamp(80px,20vw,130px);object-fit:contain;flex-shrink:0;"><span>强制停留</span>`);
}

function hideLuzhangTooltip() {
}

function hideExtraTurnTooltip() {
}

function initCardTooltip() {
  document.querySelectorAll('.m3-status-icon[data-tooltip]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const tooltipText = el.dataset.tooltip;
      let imgHtml = '';
      if (el.tagName === 'IMG') {
        imgHtml = `<img src="${el.src}" style="width:clamp(80px,20vw,130px);height:clamp(80px,20vw,130px);object-fit:contain;flex-shrink:0;">`;
      } else {
        const innerImg = el.querySelector('img');
        if (innerImg) {
          imgHtml = `<img src="${innerImg.src}" style="width:clamp(80px,20vw,130px);height:clamp(80px,20vw,130px);object-fit:contain;flex-shrink:0;">`;
        } else {
          imgHtml = `<span style="font-size:60px;flex-shrink:0;">${el.textContent || ''}</span>`;
        }
      }
      showPopupMessage(`${imgHtml}<span>${tooltipText}</span>`);
    };
  });

  document.querySelectorAll('.extra-turn-badge').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      clearPopupMessages();
      const turnCount = el.dataset.tooltip || '再动一次';
      showPopupMessage(`<span style="font-size:60px;flex-shrink:0;">🔂</span><span>${turnCount}</span>`);
    };
  });

  document.querySelectorAll('.cards-container').forEach(container => {
    let isDown = false;
    let startX;
    let scrollLeft;
    
    container.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('card-thumb')) return;
      isDown = true;
      startX = e.pageX - container.offsetLeft;
      scrollLeft = container.scrollLeft;
    });
    
    container.addEventListener('mouseleave', () => {
      isDown = false;
    });
    
    container.addEventListener('mouseup', () => {
      isDown = false;
    });
    
    container.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      e.preventDefault();
      const x = e.pageX - container.offsetLeft;
      const walk = (x - startX) * 2;
      container.scrollLeft = scrollLeft - walk;
    });
    
    container.addEventListener('touchstart', (e) => {
      startX = e.touches[0].pageX - container.offsetLeft;
      scrollLeft = container.scrollLeft;
    });
    
    container.addEventListener('touchmove', (e) => {
      const x = e.touches[0].pageX - container.offsetLeft;
      const walk = (x - startX) * 2;
      container.scrollLeft = scrollLeft - walk;
    });
  });
}

function showCardPackPanel() {
  const existing = document.getElementById('cardPackPanel');
  if (existing) { existing.remove(); return; }
  
  const me = players.find(p => p.id === myId);
  if (!me) return;
  
  const bottomBar = document.getElementById('bottomBar');
  if (!bottomBar) return;
  
  const panel = document.createElement('div');
  panel.id = 'cardPackPanel';
  const gameEl = document.getElementById('game');
  panel.style.cssText = 'position:absolute;bottom:55px;left:0;right:0;background:rgba(0,0,0,1);z-index:200;max-height:320px;display:flex;flex-direction:column;gap:4px;padding:6px;';
  panel.innerHTML = '<style>#cardPackPanel::-webkit-scrollbar{display:none;}</style>';
  
  const isMyTurn = players && players[currentPlayerIdx] && players[currentPlayerIdx].id === myId;
  const cur = players[currentPlayerIdx];
  const curSpace = cur ? board[cur.position] : null;
  
  // 宠物栏：有宠物显示宠物，无宠物显示占位图片
  const petRow = document.createElement('div');
  petRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 6px;background:rgba(255,255,255,0.08);border-radius:6px;min-height:80px;flex-shrink:0;';
  
  const petImgWrap = document.createElement('div');
  petImgWrap.style.cssText = 'position:relative;width:80px;height:80px;flex-shrink:0;';
  const petImg = document.createElement('img');
  
  if (me.petImage) {
    const isCwq = me.petImage && me.petImage.startsWith('cw');
    const petSrc = isCwq ? `/drawable/chongwu/chongwu2/${me.petImage}` : `/drawable/chongwu/${me.petImage}`;
    petImg.src = petSrc;
    const opacity = me.petFlipped ? 0.4 : 1;
    petImg.style.cssText = `width:80px;height:80px;object-fit:contain;border-radius:4px;opacity:${opacity};`;
    if (me.petFlipped) {
      const flippedLabel = document.createElement('div');
      flippedLabel.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:clamp(16px,4vw,24px);font-weight:bold;text-shadow:0 0 4px #000;pointer-events:none;white-space:nowrap;';
      flippedLabel.textContent = '翻面';
      petImgWrap.appendChild(flippedLabel);
    }
  } else {
    // 无宠物时不显示宠物栏
    petRow.style.display = 'none';
  }
  
  petImgWrap.appendChild(petImg);
  petRow.appendChild(petImgWrap);
  
  if (me.petImage) {
    const petInfo = getPetInfo(me.petImage);
    // 按钮和说明上下排列的容器
    const textCol = document.createElement('div');
    textCol.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;';
    const skillBtn = document.createElement('button');
    skillBtn.textContent = petInfo ? petInfo.name : '技能';
    const isPassive = me.petImage && isPassivePet(me.petImage);
    const flippedStyle = me.petFlipped ? 'pointer-events:none;opacity:0.6;' : '';
    if (isPassive) {
      skillBtn.style.cssText = `padding:4px 12px;font-size:clamp(12px,3vw,20px);background:#fff;color:#000;border:1px solid #999;border-radius:4px;flex-shrink:0;align-self:flex-start;${flippedStyle}`;
      if (petInfo && petInfo.name === '睡眠树懒') {
        const hideSloth = !isMyTurn || me.inJail || hasRolledThisTurn;
        if (hideSloth) skillBtn.style.display = 'none';
      }
    } else {
      const isSloth = petInfo && petInfo.name === '睡眠树懒';
      if (isSloth) console.log('isSloth', 'isMyTurn:', isMyTurn, 'hasRolledThisTurn:', hasRolledThisTurn, 'inJail:', me.inJail);
      const hide = !isMyTurn || (isSloth ? hasRolledThisTurn : activePetUsedThisTurn) || (me.inJail && !(petInfo && (petInfo.name === '影魔' || petInfo.name === '蜇人蜂'))) || (petInfo && petInfo.name === '夏蝉' && (cicadaActive || cicadaCooldown));
      if (isSloth) console.log('hide:', hide);
      skillBtn.style.cssText = `padding:4px 12px;font-size:clamp(12px,3vw,20px);background:#4CAF50;color:#fff;border:none;border-radius:4px;flex-shrink:0;align-self:flex-start;${flippedStyle}`;
      skillBtn.className = 'cicada-skill-btn';
      if (hide) skillBtn.style.display = 'none';
    }
    skillBtn.onclick = (e) => {
      e.stopPropagation();
      // 睡眠树懒：技能按钮
      if (petInfo && petInfo.name === '睡眠树懒' && !me.petFlipped) {
        socket.emit('activateSloth');
        skillBtn.style.display = 'none';
        return;
      }
      if (isPassive || me.petFlipped) return;
      if (petInfo && petInfo.name === '夏蝉' && !cicadaActive) {
        socket.emit('activateCicada');
        skillBtn.style.display = 'none';
        activePetUsedThisTurn = true;
        showCardPackPanel();
      } else if (petInfo && petInfo.name === '寒冰猛犸') {
        socket.emit('activateMammoth');
        skillBtn.style.display = 'none';
        activePetUsedThisTurn = true;
        showCardPackPanel();
      } else if (petInfo && petInfo.name === '混沌') {
        socket.emit('activateHundun');
        skillBtn.style.display = 'none';
        activePetUsedThisTurn = true;
        showCardPackPanel();
      } else if (petInfo && petInfo.name === '美猴王') {
        socket.emit('activateMeihouwang');
        skillBtn.style.display = 'none';
        activePetUsedThisTurn = true;
        showCardPackPanel();
      } else if (petInfo && petInfo.name === '神速蜗牛') {
        if (me.petFlipped || (me.snailCharges !== undefined && me.snailCharges <= 0)) return;
        socket.emit('activateSnail');
        skillBtn.style.display = 'none';
        activePetUsedThisTurn = true;
        showCardPackPanel();
      } else if (petInfo && petInfo.name === '猎豹') {
        if (me.petFlipped) return;
        socket.emit('activateLiebao');
        skillBtn.style.display = 'none';
        activePetUsedThisTurn = true;
        showCardPackPanel();
      } else if (petInfo && petInfo.name === '汗血马') {
        if (me.petFlipped) return;
        socket.emit('activateHanxueMa');
        skillBtn.style.display = 'none';
        activePetUsedThisTurn = true;
        showCardPackPanel();
      } else if (petInfo && petInfo.name === '百足虫') {
        if (me.petFlipped || currentDiceValue !== 0) return;
        socket.emit('activateBaizuchong');
        skillBtn.style.display = 'none';
        activePetUsedThisTurn = true;
        showCardPackPanel();
      } else if (petInfo && petInfo.name === '细胞') {
        if (me.petFlipped) return;
        socket.emit('activateXibao');
        skillBtn.style.display = 'none';
        activePetUsedThisTurn = true;
        showCardPackPanel();
      } else if (petInfo && petInfo.name === '蜇人蜂') {
        if (me.petFlipped) return;
        socket.emit('activateZheRenFeng');
        skillBtn.style.display = 'none';
        activePetUsedThisTurn = true;
        showCardPackPanel();
      } else if (petInfo && petInfo.name === '影魔') {
        if (me.petFlipped) return;
        if (me.yingmoCharges !== undefined && me.yingmoCharges <= 0) return;
        socket.emit('activateYingMo');
        skillBtn.style.display = 'none';
        activePetUsedThisTurn = true;
        showCardPackPanel();
      }
    };
    if (petInfo && petInfo.name === '神速蜗牛') {
      const charges = me.snailCharges !== undefined ? me.snailCharges : 2;
      skillBtn.innerHTML = `神速蜗牛 ${'★'.repeat(charges)}${'☆'.repeat(2 - charges)}`;
    }
    if (petInfo && petInfo.name === '影魔') {
      const charges = me.yingmoCharges !== undefined ? me.yingmoCharges : 3;
      skillBtn.innerHTML = `影魔 ${'★'.repeat(charges)}${'☆'.repeat(3 - charges)}`;
    }
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;align-items:center;gap:4px;';
    btnRow.appendChild(skillBtn);
    if (petInfo && petInfo.name === '影魔' && window.yingmoPosition !== null && (window.yingmoPosition === 37 || window.yingmoPosition === 38 || window.yingmoPosition === 39 || window.yingmoPosition === 40)) {
      const jailIcon = document.createElement('span');
      jailIcon.style.cssText = 'cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex-shrink:0;';
      jailIcon.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16"><line x1="2" y1="8" x2="14" y2="8" stroke="#fff" stroke-width="2"/><line x1="5" y1="2" x2="5" y2="14" stroke="#fff" stroke-width="1.8"/><line x1="8" y1="2" x2="8" y2="14" stroke="#fff" stroke-width="1.8"/><line x1="11" y1="2" x2="11" y2="14" stroke="#fff" stroke-width="1.8"/></svg>';
      jailIcon.onclick = (e) => { e.stopPropagation(); showJailPanel(); };
      btnRow.appendChild(jailIcon);
    }
    textCol.appendChild(btnRow);

    // 按钮下方显示宠物说明
    if (petInfo) {
      const descSpan = document.createElement('div');
      descSpan.style.cssText = 'color:#fff;font-size:clamp(12px,3vw,16px);line-height:1.4;word-break:break-all;opacity:0.9;';
      descSpan.textContent = petInfo.desc;
      textCol.appendChild(descSpan);
    }
    petRow.appendChild(textCol);
  }
  
  panel.appendChild(petRow);
  
  const scrollContainer = document.createElement('div');
  scrollContainer.style.cssText = 'overflow-y:auto;scrollbar-width:none;flex:1;min-height:0;display:flex;flex-direction:column;gap:4px;';
  scrollContainer.innerHTML = '<style>div::-webkit-scrollbar{display:none;}</style>';
  
  const items = [];
  
  if (me.cards && me.cards.length > 0) {
    me.cards.forEach((c, i) => {
      items.push({ type: 'card', card: c, index: i });
    });
  }
  if (me.extraPets && me.extraPets.length > 0) {
    me.extraPets.forEach(pet => {
      items.push({ type: 'pet', pet: pet });
    });
  }
  
  const noUseCards = ['免休卡', '隐藏卡', '钥匙', '多功能卡', '保护卡'];
  
  items.forEach(item => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 6px;background:rgba(255,255,255,0.08);border-radius:6px;min-height:50px;';
    
    if (item.type === 'card') {
      const c = item.card;
      const img = document.createElement('img');
      img.src = `/drawable/kapian/${c.image}.png`;
      img.style.cssText = 'width:40px;height:40px;object-fit:contain;flex-shrink:0;border-radius:4px;';
      row.appendChild(img);
      
      const isHiddenSub = c.hiddenType && c.name.startsWith('隐藏卡·');
      const cardName = isHiddenSub ? '隐藏卡' : c.name;
      let cardDesc = isHiddenSub ? '隐藏卡：效果仅卡主可见' : c.description;
      
      const hasUseBtn = cardName && !noUseCards.includes(cardName);
      
      const diceCards = ['骰子1', '骰子2', '骰子3'];
      const isDiceCard = diceCards.includes(cardName);
      const colorDiceTypes = ['掷两个骰子，二选一作为落点', '两个骰子和作为点数', '掷的点数+2，获得等量金钱', '连续动2次', '自选点数'];
      const isColorDice = colorDiceTypes.includes(cardName);
      const isExtraTurnCard = cardName === '连续动2次';
      const diceCardDisabled = (isDiceCard || (isColorDice && !isExtraTurnCard)) && (waitingForTurnEnd || !document.getElementById('areaG')?.querySelector('img'));
      const extraTurnCardDisabled = isExtraTurnCard && (waitingForTurnEnd || !isMyTurn);
      
      let qiangchaiDisabled = false;
      if (cardName === '强拆卡') {
        if (!curSpace || !curSpace.isProperty || !curSpace.owner || curSpace.owner === cur?.id || !curSpace.houseLevel || curSpace.houseLevel < 1) {
          qiangchaiDisabled = true;
        }
      }
      let zhengdiDisabled = false;
      if (cardName === '征地卡') {
        if (!curSpace || !curSpace.isProperty || !curSpace.owner || curSpace.owner === cur?.id) {
          zhengdiDisabled = true;
        }
      }
      let heikeDisabled = false;
      if (cardName === '黑客卡') {
        const hasTarget = players.some(p => !p.bankrupt && p.id !== cur?.id && p.frozen > 0);
        if (!hasTarget) heikeDisabled = true;
      }
      
      if (hasUseBtn) {
        const useBtn = document.createElement('button');
        useBtn.textContent = '使用';
        useBtn.style.cssText = 'padding:4px 12px;font-size:clamp(12px,3vw,20px);background:#4CAF50;color:#fff;border:none;border-radius:4px;cursor:pointer;flex-shrink:0;pointer-events:auto;';
        useBtn.disabled = !isMyTurn || diceCardDisabled || extraTurnCardDisabled || qiangchaiDisabled || zhengdiDisabled || heikeDisabled;
        if (useBtn.disabled) useBtn.style.cssText += 'opacity:0.4;cursor:not-allowed;';
        useBtn.onclick = (e) => {
          e.stopPropagation();
          panel.remove();
          socket.emit('useCard', { cardName, cardIndex: item.index });
        };
        row.appendChild(useBtn);
      }
      
      const descDiv = document.createElement('div');
      descDiv.style.cssText = 'color:#fff;font-size:clamp(11px,2.8vw,16px);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;flex:1;min-width:0;line-height:1.3;';
      descDiv.textContent = cardDesc || cardName;
      row.appendChild(descDiv);
      
    } else if (item.type === 'pet') {
      const img = document.createElement('img');
      const isCwqPet = item.pet && item.pet.startsWith('cw');
      img.src = isCwqPet ? `/drawable/chongwu/chongwu2/${item.pet}` : `/drawable/chongwu/${item.pet}`;
      img.style.cssText = 'width:40px;height:40px;object-fit:contain;flex-shrink:0;border-radius:4px;';
      row.appendChild(img);

      const canSwap = !me.petImage || me.petFlipped;
      const swapBtn = document.createElement('button');
      swapBtn.textContent = '换上';
      swapBtn.style.cssText = 'padding:4px 12px;font-size:clamp(12px,3vw,20px);background:#4CAF50;color:#fff;border:none;border-radius:4px;cursor:pointer;flex-shrink:0;pointer-events:auto;';
      swapBtn.disabled = !canSwap;
      if (!canSwap) swapBtn.style.cssText += 'opacity:0.4;cursor:not-allowed;';
      swapBtn.onclick = (e) => {
        e.stopPropagation();
        if (swapBtn.disabled) return;
        const meRef = players.find(p => p.id === myId);
        if (meRef) {
          const oldPet = meRef.petImage;
          meRef.extraPets = meRef.extraPets.filter(p => p !== item.pet);
          if (oldPet) {
            if (!meRef.extraPets) meRef.extraPets = [];
            meRef.extraPets.push(oldPet);
          }
          meRef.petImage = item.pet;
        }
        socket.emit('swapPet', { petName: item.pet });
        panel.remove();
        showCardPackPanel();
      };
      row.appendChild(swapBtn);

      const petInfo = getPetInfo(item.pet);
      if (petInfo) {
        const descSpan = document.createElement('div');
        descSpan.style.cssText = 'color:#fff;font-size:clamp(11px,2.8vw,16px);flex:1;min-width:0;line-height:1.3;word-break:break-all;';
        descSpan.textContent = `${petInfo.name}：${petInfo.desc}`;
        row.appendChild(descSpan);
      }
    }
    
    scrollContainer.appendChild(row);
  });
  
  if (items.length === 0 && !me.petImage) {
    scrollContainer.innerHTML = '<div style="color:#888;text-align:center;padding:20px;">没有卡片</div>';
  }
  
  panel.appendChild(scrollContainer);
  
  if (gameEl) {
    gameEl.style.position = 'relative';
    gameEl.appendChild(panel);
  }
  
  const closeHandler = (e) => {
    if (!panel.contains(e.target)) {
      panel.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

let emojiVideos = [];
for (let i = 1; i <= 74; i++) {
  emojiVideos.push({ video: `/drawable/biaoqingbao/${i}.mp4`, image: `/drawable/biaoqingbao/${i}.jpg` });
}

let emojiBlocked = false;

function showEmojiPanel() {
  const boardArea = $('hArea');
  if (!boardArea) return;
  
  let panel = document.querySelector('.emoji-panel');
  if (panel) {
    panel.remove();
    return;
  }
  
  panel = document.createElement('div');
  panel.className = 'emoji-panel';
  
  const blockBtn = document.createElement('div');
  blockBtn.className = 'emoji-item';
  blockBtn.style.background = '#3a1a1a';
  blockBtn.style.display = 'flex';
  blockBtn.style.alignItems = 'center';
  blockBtn.style.justifyContent = 'center';
  blockBtn.style.color = '#fff';
  blockBtn.style.fontSize = '12px';
  blockBtn.textContent = emojiBlocked ? '打开表情包' : '屏蔽表情包';
  
  blockBtn.onclick = (e) => {
    e.stopPropagation();
    emojiBlocked = !emojiBlocked;
    panel.remove();
  };
  
  panel.appendChild(blockBtn);
  
  emojiVideos.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = 'emoji-item';
    div.style.background = '#1a2a4a';
    
    const img = document.createElement('img');
    img.src = item.image;
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    
    img.onerror = () => {
      div.textContent = index + 1;
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.justifyContent = 'center';
      div.style.color = '#fff';
      div.style.fontWeight = 'bold';
    };
    
    div.appendChild(img);
    
    div.onclick = (e) => {
      e.stopPropagation();
      socket.emit('playEmoji', { src: item.video });
      panel.remove();
    };
    
    panel.appendChild(div);
  });
  
  boardArea.appendChild(panel);
  
  panel.onclick = (e) => {
    if (e.target === panel) {
      panel.remove();
    }
  };
}

socket.on('showEmoji', ({ src, playerId }) => {
  if (emojiBlocked) return;
  
  let oldPlayer = document.querySelector('.emoji-player');
  if (oldPlayer) {
    const oldVideo = oldPlayer.querySelector('video');
    if (oldVideo) {
      oldVideo.pause();
      oldVideo.src = '';
      oldVideo.load();
    }
    oldPlayer.remove();
  }
  
  const sender = players.find(p => p.id === playerId);
  if (!sender) return;
  
  const senderCard = document.querySelector(`.player-card[data-card="${sender.id}"]`);
  if (!senderCard) return;
  
  const player = document.createElement('div');
  player.className = 'emoji-player';
  player.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.3);border-radius:8px;pointer-events:none;';
  
  const video = document.createElement('video');
  video.style.cssText = 'width:clamp(40px,8vh,60px);height:clamp(40px,8vh,60px);object-fit:contain;';
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.setAttribute('x5-video-player-type', 'h5');
  video.setAttribute('x5-video-player-fullscreen', 'true');
  video.setAttribute('preload', 'auto');
  
  let timeoutId = null;
  
  const removePlayer = () => {
    if (timeoutId) clearTimeout(timeoutId);
    video.pause();
    video.removeAttribute('src');
    video.load();
    player.remove();
  };
  
  timeoutId = setTimeout(removePlayer, 10000);
  
  video.onloadedmetadata = () => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(removePlayer, (video.duration + 1) * 1000);
  };
  
  video.onended = removePlayer;
  
  video.onerror = removePlayer;
  
  player.appendChild(video);
  senderCard.appendChild(player);
  senderCard.style.position = 'relative';
  
  video.src = src + '?t=' + Date.now();
  video.load();
  
  const playVideo = () => {
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => {});
    });
  };
  
  video.oncanplay = playVideo;
  
  if (typeof WeixinJSBridge !== 'undefined') {
    WeixinJSBridge.invoke('getNetworkType', {}, () => {
      playVideo();
    });
  } else {
    document.addEventListener('WeixinJSBridgeReady', () => {
      WeixinJSBridge.invoke('getNetworkType', {}, () => {
        playVideo();
      });
    }, false);
  }
  
  player.onclick = (e) => {
    e.stopPropagation();
    removePlayer();
  };
});

window.addEventListener('resize', () => {
  adjustPlayerNameFontSize();
});
}