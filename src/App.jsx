import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Activity, 
  Settings, 
  AlertTriangle, 
  TrendingUp, 
  TrendingDown, 
  Search, 
  Zap, 
  BarChart2, 
  Clock,
  Wifi,
  WifiOff,
  Loader2,
  ListFilter,
  Bell,
  BellRing,
  Volume2,
  RefreshCw,
  ArrowRight
} from 'lucide-react';

const App = () => {
  // --- 核心状态 ---
  const [contracts, setContracts] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [threshold, setThreshold] = useState(2.0); // 默认两倍放量报警
  const [status, setStatus] = useState('initializing');
  const [lastUpdate, setLastUpdate] = useState(Date.now());
  
  // 模式: 'ranking' (合约榜) | 'custom' (自选)
  const [mode, setMode] = useState('ranking'); 
  
  // 排名范围配置
  const [rankRange, setRankRange] = useState({ start: 20, end: 30 }); // 实际生效的范围
  const [tempRange, setTempRange] = useState({ start: 20, end: 30 }); // 输入框的临时状态

  const [soundEnabled, setSoundEnabled] = useState(false); // 声音开关
  
  // --- 辅助状态 ---
  const [searchTerm, setSearchTerm] = useState('');
  const scrollRef = useRef(null);
  const socketRef = useRef(null);

  // 自选列表配置
  const CUSTOM_LIST = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 
    'DOGEUSDT', 'XRPUSDT', 'PEPEUSDT', 'WIFUSDT',
    'ORDIUSDT', 'SUIUSDT', 'AVAXUSDT', 'SHIBUSDT'
  ];

  // --- 音频上下文引用 ---
  const audioCtxRef = useRef(null);

  // 初始化/播放报警音效 (使用 Web Audio API，无需外部文件)
  const playAlertSound = () => {
    if (!soundEnabled) return;

    try {
      if (!audioCtxRef.current) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtxRef.current = new AudioContext();
      }

      const ctx = audioCtxRef.current;

      // 如果上下文被挂起（通常是因为自动播放策略），尝试恢复
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      
      // 创建振荡器 (生成声音)
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      // 设置音调：急促的报警音 (频率从高到低)
      osc.type = 'sawtooth'; // 锯齿波，听起来更警觉
      osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.2);

      // 设置音量包络
      gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);

      osc.start();
      osc.stop(ctx.currentTime + 0.2);

      // 连续响两声
      setTimeout(() => {
        // 再次检查 ctx 状态，防止在播放间隔期间组件卸载
        if (ctx.state === 'closed') return;

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.type = 'sawtooth';
        osc2.frequency.setValueAtTime(880, ctx.currentTime);
        osc2.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.2);
        gain2.gain.setValueAtTime(0.3, ctx.currentTime);
        gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc2.start();
        osc2.stop(ctx.currentTime + 0.2);
      }, 250);

    } catch (e) {
      console.error("Audio playback failed", e);
    }
  };

  // 触发震动
  const triggerVibration = () => {
    if (!soundEnabled) return;
    // 检查浏览器是否支持 Vibration API
    if (navigator.vibrate) {
      // 震动模式：500ms震动 - 200ms停止 - 500ms震动
      navigator.vibrate([500, 200, 500]);
    }
  };

  // 切换声音开关
  const toggleSound = () => {
    if (!soundEnabled) {
      // 开启时尝试播放一声，以解锁浏览器自动播放限制
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        // 如果已存在且未关闭，复用；否则新建
        if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
             audioCtxRef.current = new AudioContext();
        }
        
        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended') {
            ctx.resume();
        }

        // 播放一个极短的静音或提示音
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.1);
      }
      setSoundEnabled(true);
      // 提示震动一下
      if (navigator.vibrate) navigator.vibrate(100);
    } else {
      setSoundEnabled(false);
    }
  };

  // --- 处理排名范围输入 ---
  const handleRangeChange = (type, value) => {
    setTempRange(prev => ({
      ...prev,
      [type]: parseInt(value) || ''
    }));
  };

  const applyRange = () => {
    let { start, end } = tempRange;
    
    // 基础验证
    if (!start || start < 1) start = 1;
    if (!end || end > 300) end = 100; // 防止请求过多
    if (start > end) {
      const t = start; start = end; end = t; // 自动交换
    }
    
    setTempRange({ start, end });
    setRankRange({ start, end });
    setMode('ranking'); // 确保切换回 ranking 模式
  };

  // --- 1. 获取目标合约列表及初始Ticker数据 ---
  const fetchTargetSymbols = async () => {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
        const allTickers = await res.json();

        let targets = [];

        if (mode === 'custom') {
            targets = allTickers.filter(t => CUSTOM_LIST.includes(t.symbol));
        } else {
            // 过滤掉非USDT合约、USDC合约和指数合约
            const candidates = allTickers.filter(t => {
                const s = t.symbol;
                return s.endsWith('USDT') && 
                       !s.includes('_') && 
                       !s.startsWith('USDC');
            });

            // 按涨幅降序排序
            candidates.sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent));

            // 根据 rankRange 截取
            // 注意：slice 是 0-based，rank 是 1-based
            const startIdx = Math.max(0, rankRange.start - 1);
            const endIdx = rankRange.end;
            
            targets = candidates.slice(startIdx, endIdx);
            
            console.log(`Selected Futures Top ${rankRange.start}-${rankRange.end}:`, targets.map(t => `${t.symbol} (${t.priceChangePercent}%)`));
        }

        return targets.map(t => ({
            symbol: t.symbol,
            change: parseFloat(t.priceChangePercent),
            price: parseFloat(t.lastPrice)
        }));

    } catch (e) {
        console.error("Failed to fetch futures ranks", e);
        // 如果失败，回退到自选列表
        return CUSTOM_LIST.map(s => ({ symbol: s, change: 0, price: 0 }));
    }
  };

  // --- 2. 初始化流程 ---
  useEffect(() => {
    let isMounted = true;

    const initData = async () => {
      setStatus('initializing');
      setContracts([]); 
      
      const targetData = await fetchTargetSymbols();
      
      if (!isMounted) return;

      try {
        const promises = targetData.map(async (target) => {
          try {
            const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${target.symbol}&interval=1d&limit=7`);
            const data = await res.json();
            
            const last5Days = data.slice(data.length - 6, data.length - 1);
            const totalVol = last5Days.reduce((acc, k) => acc + parseFloat(k[5]), 0);
            const avgVol = totalVol / last5Days.length;
            
            const klinePrice = parseFloat(data[data.length - 1][4]);

            return {
              id: target.symbol,
              symbol: target.symbol,
              name: target.symbol.replace('USDT', ''),
              price: target.price || klinePrice, 
              change: target.change,             
              vol1m: 0,
              vol5dAvg: avgVol || 1,
              lastUpdated: Date.now()
            };
          } catch (err) {
            console.error(`Failed to fetch ${target.symbol}`, err);
            return null;
          }
        });

        const results = await Promise.all(promises);
        const validContracts = results.filter(c => c !== null);
        
        if (isMounted) {
            setContracts(validContracts);
            startWebSocket(validContracts);
        }

      } catch (error) {
        console.error("Init Error:", error);
        setStatus('error');
      }
    };

    initData();

    return () => {
      isMounted = false;
      if (socketRef.current) socketRef.current.close();
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, [mode, rankRange]); // 依赖项加入 rankRange

  // --- 3. WebSocket 连接 ---
  const startWebSocket = (currentContracts) => {
    if (socketRef.current) socketRef.current.close();
    if (currentContracts.length === 0) return;

    const streams = currentContracts.map(c => {
      const s = c.symbol.toLowerCase();
      return `${s}@kline_1m/${s}@miniTicker`;
    }).join('/');

    const wsUrl = `wss://fstream.binance.com/stream?streams=${streams}`;
    
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      handleStreamMessage(message);
    };

    ws.onerror = (err) => {
      setStatus('error');
    };
    ws.onclose = () => {
      setStatus('disconnected');
    };
  };

  // --- 4. 消息处理 ---
  const handleStreamMessage = (message) => {
    if (!message.data) return;

    const data = message.data;
    const stream = message.stream;
    
    setContracts(prev => {
      return prev.map(contract => {
        if (!stream.includes(contract.symbol.toLowerCase())) return contract;

        let updated = { ...contract };

        if (data.e === 'kline') {
          const k = data.k;
          const currentVol = parseFloat(k.v);
          updated.vol1m = currentVol;
          checkStrategy(updated, currentVol);
        }

        if (data.e === '24hrMiniTicker') {
          const close = parseFloat(data.c);
          const open = parseFloat(data.o);
          updated.price = close;
          if (open && open !== 0) {
            updated.change = ((close - open) / open) * 100;
          }
        }

        return updated;
      });
    });
    setLastUpdate(Date.now());
  };

  // --- 5. 策略核心 ---
  const checkStrategy = (contract, currentVol) => {
    const minuteAvgRef = contract.vol5dAvg / 1440; 
    if (!minuteAvgRef || minuteAvgRef === 0) return;

    const ratio = parseFloat((currentVol / minuteAvgRef).toFixed(2));
    const isBreakout = ratio > threshold;
    
    if (isBreakout) {
      setAlerts(prev => {
        const lastAlert = prev.find(a => a.symbol === contract.symbol);
        // 防抖：5秒内不重复报
        if (lastAlert && (Date.now() - lastAlert.time < 5000)) return prev;

        // ** 强提醒逻辑：大于15倍量时 **
        if (ratio >= 15) {
          playAlertSound();   // 播放声音
          triggerVibration(); // 触发震动
        }

        setTimeout(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = 0;
        }, 100);

        return [{
          id: Date.now() + Math.random(),
          time: Date.now(),
          symbol: contract.symbol,
          price: contract.price,
          ratio: ratio,
          vol: currentVol,
          msg: `放量 ${ratio}x`,
          isHighAlert: ratio >= 15 // 标记为高等级报警
        }, ...prev].slice(0, 50);
      });
    }
  };

  // --- UI Formatters ---
  const formatNumber = (num) => {
    if (!num) return '0.00';
    if (num < 0.01) return num.toPrecision(4);
    if (num > 1000) return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  };

  const formatVolume = (num) => {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toFixed(0);
  };

  const filteredContracts = contracts.filter(c => 
    c.symbol.toLowerCase().includes(searchTerm.toLowerCase()) || 
    c.name.includes(searchTerm)
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans selection:bg-indigo-500 selection:text-white pb-10">
      {/* 顶部导航 */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-[#F0B90B] p-2 rounded-lg text-slate-900">
              <Activity size={24} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                Binance Scanner 
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-normal">Futures</span>
              </h1>
              <p className="text-xs text-slate-400">
                {mode === 'ranking' ? `监控: 合约榜 #${rankRange.start}-${rankRange.end}` : '监控: 自选合约列表'}
              </p>
            </div>
          </div>
          
          <div className="flex items-center gap-2 md:gap-4">
            {/* 声音开关按钮 */}
            <button
              onClick={toggleSound}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all active:scale-95 ${
                soundEnabled 
                  ? 'bg-indigo-900/50 border-indigo-500 text-indigo-300 shadow-[0_0_10px_rgba(99,102,241,0.3)]' 
                  : 'bg-slate-800 border-slate-700 text-slate-400'
              }`}
            >
              {soundEnabled ? <BellRing size={16} className="animate-pulse" /> : <Bell size={16} />}
              <span className="text-xs hidden md:inline">{soundEnabled ? '声音开启 (15x)' : '声音关闭'}</span>
            </button>

            <div className={`hidden md:flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border transition-all ${
              status === 'connected' ? 'bg-emerald-950/30 border-emerald-800 text-emerald-400' : 
              status === 'initializing' ? 'bg-indigo-950/30 border-indigo-800 text-indigo-400' :
              'bg-red-950/30 border-red-800 text-red-400'
            }`}>
              {status === 'initializing' && <Loader2 size={12} className="animate-spin" />}
              {status === 'connected' && <Wifi size={12} />}
              {(status === 'error' || status === 'disconnected') && <WifiOff size={12} />}
              <span className="capitalize">{status === 'initializing' ? '加载中...' : status}</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-2 md:px-4 py-4 md:py-6 grid grid-cols-1 lg:grid-cols-12 gap-4 md:gap-6">
        
        {/* 左侧控制面板与列表 (8列) */}
        <div className="lg:col-span-8 space-y-4 md:space-y-6">
          
          {/* 策略控制卡片 */}
          <div className="bg-slate-900 rounded-xl border border-slate-800 p-3 md:p-5 shadow-lg">
            
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4 md:mb-6">
              
              {/* 模式选择与范围设置区 */}
              <div className="flex flex-col md:flex-row gap-3">
                <div className="flex items-center gap-2 overflow-x-auto pb-1 md:pb-0 scrollbar-hide">
                  <button 
                    onClick={() => setMode('ranking')}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs md:text-sm font-medium transition-all whitespace-nowrap ${
                      mode === 'ranking' 
                        ? 'bg-indigo-600 text-white shadow-indigo-500/20 shadow-lg' 
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}
                  >
                    <ListFilter size={14} className="md:w-4 md:h-4" />
                    合约榜
                  </button>
                  <button 
                    onClick={() => setMode('custom')}
                    className={`px-3 py-2 rounded-lg text-xs md:text-sm font-medium transition-all whitespace-nowrap ${
                      mode === 'custom' 
                        ? 'bg-indigo-600 text-white shadow-indigo-500/20 shadow-lg' 
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}
                  >
                    自选列表
                  </button>
                </div>

                {/* 仅在 Ranking 模式下显示的范围输入框 */}
                {mode === 'ranking' && (
                  <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 animate-in fade-in slide-in-from-left-2 duration-300">
                    <span className="text-[10px] md:text-xs text-slate-500 uppercase font-bold mr-1">Rank</span>
                    <input 
                      type="number" 
                      min="1" 
                      max="200"
                      className="w-10 bg-transparent border-b border-slate-600 text-center text-sm focus:outline-none focus:border-indigo-500 font-mono text-slate-200"
                      value={tempRange.start}
                      onChange={(e) => handleRangeChange('start', e.target.value)}
                    />
                    <ArrowRight size={12} className="text-slate-600" />
                    <input 
                      type="number" 
                      min="1" 
                      max="200"
                      className="w-10 bg-transparent border-b border-slate-600 text-center text-sm focus:outline-none focus:border-indigo-500 font-mono text-slate-200"
                      value={tempRange.end}
                      onChange={(e) => handleRangeChange('end', e.target.value)}
                    />
                    <button 
                      onClick={applyRange}
                      className="ml-1 p-1 hover:bg-slate-800 rounded-md text-indigo-400 transition-colors"
                      title="应用新范围"
                    >
                      <RefreshCw size={14} />
                    </button>
                  </div>
                )}
              </div>

              <div className="relative w-full md:w-auto">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
                <input 
                  type="text" 
                  placeholder="筛选代码..." 
                  className="bg-slate-950 border border-slate-700 text-sm rounded-lg pl-9 pr-4 py-2 w-full md:w-48 focus:ring-2 focus:ring-indigo-500 focus:outline-none placeholder:text-slate-600"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
            </div>

            <div className="bg-slate-950/50 rounded-lg p-3 md:p-4 border border-slate-800/50">
              <div className="flex flex-col gap-2">
                <div className="flex justify-between text-xs md:text-sm">
                  <div className="flex items-center gap-2">
                    <Settings size={14} className="text-indigo-400" />
                    <span className="text-slate-400">列表高亮阈值 (当前 ≥ 15x 将响铃)</span>
                  </div>
                  <span className="text-indigo-400 font-mono font-bold">{threshold.toFixed(1)}x</span>
                </div>
                <input 
                  type="range" 
                  min="1.0" 
                  max="10.0" 
                  step="0.5" 
                  value={threshold}
                  onChange={(e) => setThreshold(parseFloat(e.target.value))}
                  className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
              </div>
            </div>
          </div>

          {/* 市场列表 */}
          <div className="bg-slate-900 rounded-xl border border-slate-800 shadow-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-950 text-slate-400 text-[10px] md:text-xs uppercase tracking-wider border-b border-slate-800">
                    {/* 手机端减小 Padding */}
                    <th className="px-2 py-3 md:p-4 font-medium">合约</th>
                    <th className="px-2 py-3 md:p-4 font-medium text-right">价格</th>
                    <th className="px-2 py-3 md:p-4 font-medium text-right">24H%</th>
                    <th className="px-2 py-3 md:p-4 font-medium text-right">1m量</th>
                    {/* 手机端基准量可以隐藏或缩小 */}
                    <th className="hidden md:table-cell px-2 py-3 md:p-4 font-medium text-right">基准</th>
                    <th className="px-2 py-3 md:p-4 font-medium text-center">状态</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {status === 'initializing' ? (
                    <tr>
                      <td colSpan="6" className="p-16 text-center text-slate-500">
                        <div className="flex flex-col items-center gap-3">
                          <Loader2 className="animate-spin text-indigo-500" size={32} />
                          <p>正在扫描 Binance Futures 数据...</p>
                        </div>
                      </td>
                    </tr>
                  ) : filteredContracts.map((contract, index) => {
                    const minuteAvgRef = contract.vol5dAvg / 1440;
                    const ratio = minuteAvgRef > 0 ? (contract.vol1m / minuteAvgRef) : 0;
                    const isHot = ratio > threshold;
                    const isSuperHot = ratio >= 15;
                    // 在 rank 模式下显示绝对排名，custom 模式不显示
                    const displayRank = mode === 'ranking' ? (rankRange.start + index) : '';
                    
                    return (
                      <tr 
                        key={contract.id} 
                        className={`transition-colors hover:bg-slate-800/50 ${isSuperHot ? 'bg-red-900/20' : isHot ? 'bg-indigo-900/10' : ''}`}
                      >
                        <td className="px-2 py-2 md:p-4">
                          <div className="flex items-center gap-1.5 md:gap-3">
                            <span className="text-[10px] md:text-xs font-mono text-slate-600 w-3 md:w-4 text-center">
                              {displayRank}
                            </span>
                            <div className="flex flex-col">
                              {/* 手机端字体变小: text-xs md:text-base */}
                              <span className="font-bold text-slate-200 text-xs md:text-sm">{contract.symbol}</span>
                              <span className="text-[9px] md:text-[10px] text-indigo-400/70 uppercase scale-90 origin-left md:scale-100">Perp</span>
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-2 md:p-4 text-right font-mono text-slate-300 text-xs md:text-sm">
                          {formatNumber(contract.price)}
                        </td>
                        <td className={`px-2 py-2 md:p-4 text-right font-medium text-xs md:text-sm ${contract.change >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {contract.change > 0 ? '+' : ''}
                          {isNaN(contract.change) ? '0.00' : contract.change.toFixed(2)}%
                        </td>
                        <td className={`px-2 py-2 md:p-4 text-right font-mono text-xs md:text-sm transition-all duration-500 ${isSuperHot ? 'text-red-500 font-bold scale-105 md:scale-110' : isHot ? 'text-indigo-400 font-bold' : 'text-slate-400'}`}>
                          {formatVolume(contract.vol1m)}
                        </td>
                        <td className="hidden md:table-cell px-2 py-2 md:p-4 text-right font-mono text-slate-600 text-xs">
                          ~{formatVolume(minuteAvgRef)}
                        </td>
                        <td className="px-2 py-2 md:p-4 text-center">
                          {isHot ? (
                            <div className={`inline-flex items-center gap-1 px-1.5 py-0.5 md:px-2 md:py-1 rounded-full text-[10px] md:text-xs font-bold border animate-pulse ${
                              isSuperHot 
                                ? 'bg-red-500/20 text-red-400 border-red-500/30 shadow-[0_0_10px_rgba(239,68,68,0.3)]' 
                                : 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
                            }`}>
                              {isSuperHot ? <Volume2 size={10} className="md:w-3 md:h-3" /> : <Zap size={10} className="md:w-3 md:h-3" fill="currentColor" />}
                              {ratio.toFixed(1)}x
                            </div>
                          ) : (
                            <div className="w-8 md:w-12 h-1 bg-slate-800 rounded-full mx-auto overflow-hidden">
                              <div 
                                className="h-full bg-slate-600 transition-all duration-500"
                                style={{ width: `${Math.min(ratio * 20, 100)}%` }}
                              ></div>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* 右侧：异动日志 (4列) */}
        {/* 手机端高度调整: h-[320px] -> lg:h-[600px] */}
        <div className="lg:col-span-4 space-y-4 md:space-y-6">
          <div className="bg-slate-900 rounded-xl border border-slate-800 shadow-lg h-[320px] lg:h-[600px] flex flex-col">
            <div className="p-3 md:p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900 rounded-t-xl">
              <div className="flex items-center gap-2 text-amber-500">
                <AlertTriangle size={16} className="md:w-[18px] md:h-[18px]" />
                <h2 className="font-semibold text-white text-sm md:text-base">实时异动信号</h2>
              </div>
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                </span>
                <span className="text-xs text-slate-400">Live</span>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-2 md:p-4 space-y-2 md:space-y-3 custom-scrollbar" ref={scrollRef}>
              {alerts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-2">
                  <Clock size={24} className="md:w-8 md:h-8" opacity={0.2} />
                  <p className="text-xs md:text-sm">等待信号触发...</p>
                  <p className="text-[10px] md:text-xs text-slate-700 text-center px-4">
                    当成交量超过阈值时显示<br/>
                    超过 <span className="text-red-400 font-bold">15x</span> 将触发声光震动
                  </p>
                </div>
              ) : (
                alerts.map((alert) => (
                  <div key={alert.id} className={`p-2 md:p-3 rounded-lg border-l-4 shadow-sm animate-in slide-in-from-right fade-in duration-300 ${
                    alert.isHighAlert 
                      ? 'bg-red-950/30 border-red-500' 
                      : 'bg-slate-950 border-amber-500'
                  }`}>
                    <div className="flex justify-between items-start mb-0.5 md:mb-1">
                      <span className={`font-bold text-xs md:text-sm ${alert.isHighAlert ? 'text-red-400' : 'text-slate-200'}`}>
                        {alert.symbol}
                      </span>
                      <span className="text-[10px] md:text-xs text-slate-500 font-mono">
                        {new Date(alert.time).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-1 md:mt-2">
                      <div className={`text-[10px] md:text-xs font-bold flex items-center gap-1 px-1.5 py-0.5 md:px-2 md:py-1 rounded ${
                        alert.isHighAlert ? 'bg-red-950/50 text-red-400' : 'bg-amber-950/30 text-amber-400'
                      }`}>
                        {alert.isHighAlert ? <BellRing size={10} className="md:w-3 md:h-3" /> : <TrendingUp size={10} className="md:w-3 md:h-3" />}
                        {alert.msg}
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] md:text-xs text-slate-400 font-mono">Price: {formatNumber(alert.price)}</div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
            
            <div className="p-2 md:p-3 border-t border-slate-800 bg-slate-950/30 rounded-b-xl flex justify-between items-center">
              <span className="text-[10px] text-slate-600">
                Binance Futures API
              </span>
              <button 
                onClick={() => setAlerts([])}
                className="text-[10px] md:text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                清空日志
              </button>
            </div>
          </div>
        </div>

      </main>
      
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #0f172a; 
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #334155; 
          border-radius: 3px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #475569; 
        }
      `}</style>
    </div>
  );
};

export default App;
