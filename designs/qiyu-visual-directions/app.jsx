const { DesignCanvas, DCSection, DCArtboard } = window;

function BottomNav({ variant = "default" }) {
  return (
    <nav className="bottom-nav" aria-label="主导航">
      <button className="nav-item active">对话</button>
      <button className="nav-item">时间线</button>
      <button className="nav-item">关系</button>
      <button className="nav-item">我的</button>
    </nav>
  );
}

function RelationshipJournal() {
  return (
    <main className="phone journal" data-screen-label="关系手记">
      <header className="journal-top">
        <div className="journal-brand">栖语</div>
        <div className="ai-tag">AI角色</div>
      </header>
      <div className="journal-date">31 August · Monday</div>
      <section className="journal-hero">
        <div className="journal-title">
          <small>正在窗边 · 微雨</small>
          <h2>林默</h2>
          <p>今天的他，比平时安静一些。</p>
        </div>
        <img className="journal-portrait" src="imgs/qiyu-character.png" alt="原创成年角色林默的肖像"></img>
        <div className="journal-orbit"></div>
      </section>
      <section className="journal-memory">
        <span>一条记忆等待你确认</span>
        <button className="tap">查看 →</button>
      </section>
      <section className="journal-chat">
        <div className="journal-line">
          <div className="who">你</div>
          <p>今天有点累。</p>
        </div>
        <div className="journal-line">
          <div className="who">林默</div>
          <p>那就先别急着把今天收拾好。你坐一会儿，我陪你把最难的那一件事说清楚。</p>
        </div>
        <div className="journal-voice">
          <span>00:18</span>
          <div className="journal-wave"></div>
          <span>播放</span>
        </div>
      </section>
      <div className="journal-composer">
        <span>说点什么……</span>
        <button className="tap">↑</button>
      </div>
      <BottomNav />
    </main>
  );
}

function TwilightWhisper() {
  return (
    <main className="phone twilight" data-screen-label="暮色私语">
      <img className="twilight-image" src="imgs/qiyu-character.png" alt="原创成年角色林默的肖像"></img>
      <div className="twilight-shade"></div>
      <header className="twilight-top">
        <div className="twilight-brand">栖语</div>
        <div className="ai-tag">AI角色</div>
      </header>
      <section className="twilight-name">
        <small>窗边 · 微雨 · 22:14</small>
        <h2>林默</h2>
      </section>
      <div className="twilight-presence"></div>
      <section className="twilight-panel">
        <div className="twilight-context">
          <span>今晚的对话</span>
          <button className="tap">记忆待确认 1</button>
        </div>
        <div className="twilight-user">今天有点累。</div>
        <div className="twilight-bubble">那就先别急着把今天收拾好。你坐一会儿，我陪你把最难的那一件事说清楚。</div>
        <div className="twilight-audio tap">
          <span className="twilight-play">▶</span>
          <div className="line"></div>
          <small>00:18</small>
        </div>
        <div className="twilight-composer">
          <span>说点什么……</span>
          <button className="tap">↑</button>
        </div>
      </section>
      <BottomNav />
    </main>
  );
}

function ContemporaryMagazine() {
  return (
    <main className="phone magazine" data-screen-label="当代角色杂志">
      <header className="mag-top">
        <div className="mag-issue">Qiyu Character<br></br><b>ISSUE 01</b></div>
        <div className="ai-tag">AI角色</div>
      </header>
      <section className="mag-headline">
        <div className="mag-number">01</div>
        <img className="mag-photo" src="imgs/qiyu-character.png" alt="原创成年角色林默的肖像"></img>
        <div className="mag-red"></div>
        <div className="mag-label">CURRENT STATE<br></br>WINDOW · RAIN</div>
        <div className="mag-name">林默</div>
      </section>
      <section className="mag-meta">
        <span>31 AUG / MON</span>
        <span>正在窗边 · 微雨</span>
      </section>
      <section className="mag-memory">
        <b>MEMORY 01</b>
        <span>一条记忆等待确认 →</span>
      </section>
      <section className="mag-chat">
        <div className="mag-msg">
          <strong>YOU</strong>
          <p>今天有点累。</p>
        </div>
        <div className="mag-msg character">
          <strong>LIN</strong>
          <p>那就先别急着把今天收拾好。你坐一会儿，我陪你把最难的那一件事说清楚。</p>
        </div>
        <div className="mag-audio tap">
          <strong>VOICE</strong>
          <div className="mag-bars"></div>
          <span>00:18</span>
        </div>
      </section>
      <div className="mag-compose">
        <span>说点什么……</span>
        <button className="tap">↑</button>
      </div>
      <BottomNav variant="magazine" />
    </main>
  );
}

function App() {
  return (
    <DesignCanvas minScale={0.35} maxScale={1.35}>
      <DCSection id="directions" title="栖语 · 三种视觉方向" subtitle="同一角色、内容与功能结构，仅比较视觉语言。点击标题可单独放大，菜单可下载PNG。">
        <DCArtboard id="journal" label="01 · 关系手记" width={390} height={844} style={{ borderRadius: 32 }}>
          <RelationshipJournal />
        </DCArtboard>
        <DCArtboard id="twilight" label="02 · 暮色私语" width={390} height={844} style={{ borderRadius: 32 }}>
          <TwilightWhisper />
        </DCArtboard>
        <DCArtboard id="magazine" label="03 · 当代角色杂志" width={390} height={844} style={{ borderRadius: 32 }}>
          <ContemporaryMagazine />
        </DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

const direction = new URLSearchParams(window.location.search).get("direction");
const directScreens = {
  journal: <RelationshipJournal />,
  twilight: <TwilightWhisper />,
  magazine: <ContemporaryMagazine />,
};

if (directScreens[direction]) document.body.classList.add("direct-preview");
ReactDOM.createRoot(document.getElementById("root")).render(directScreens[direction] || <App />);
