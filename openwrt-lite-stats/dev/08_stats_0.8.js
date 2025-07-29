'use strict';
'require baseclass';
'require fs';

let prev = {};
let last_time = Date.now();
let ipVisible = localStorage.getItem('ipVisible') !== 'false';
const smoothing = 0.8;
let smoothed = {};
let currentIface = '';

(function loadDynamicCSS() {
  function isDarkMode() {
    try {
      const bgColor = getComputedStyle(document.body).backgroundColor;
      if (!bgColor) return false;
      const rgb = bgColor.match(/\d+/g);
      if (!rgb) return false;
      const [r, g, b] = rgb.map(Number);
      return (r * 299 + g * 587 + b * 114) / 1000 < 100;
    } catch (e) {
      console.error('Error detecting dark mode:', e);
      return false;
    }
  }

  try {
    const dark = isDarkMode();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = dark 
      ? '/luci-static/resources/netstat/netstat_dark.css' 
      : '/luci-static/resources/netstat/netstat.css';
    document.head.appendChild(link);
  } catch (e) {
    console.error('Error loading CSS:', e);
  }
})();

function getPublicIP() {
  return fs.exec('/usr/bin/curl', ['-sL', '--connect-timeout', '2', '--max-time', '3', 'https://ip.guide'])
    .then(res => {
      try {
        return JSON.parse(res.stdout);
      } catch {
        return { ip: 'Unavailable', network: { autonomous_system: { name: 'Unknown' } } };
      }
    })
    .catch(() => ({ ip: 'Unavailable', network: { autonomous_system: { name: 'Unknown' } } }));
}


function parseStats(raw) {
  try {
    const lines = raw.trim().split('\n');
    const stats = {};
    
    lines.forEach(line => {
      const parts = line.trim().split(':');
      if (parts.length < 2) return;
      
      const iface = parts[0].trim();
      const values = parts[1].trim().split(/\s+/);
      
      stats[iface] = {
        rx: parseInt(values[0]) || 0,
        tx: parseInt(values[8]) || 0
      };
    });
    
    return stats;
  } catch (e) {
    console.error('Error parsing stats:', e);
    return {};
  }
}

async function getPreferredInterfaces() {
  try {
    const res = await fs.exec('/sbin/uci', ['get', 'netstats.@config[0].prefer']);
    return res.stdout.trim().split(/\s+/).filter(Boolean);
  } catch (e) {
    console.error('Error getting preferred interfaces:', e);
    return [];
  }
}

async function setPreferredInterface(iface) {
  try {
    await fs.exec('/sbin/uci', ['set', `netstats.@config[0].prefer='${iface}'`]);
    await fs.exec('/sbin/uci', ['commit', 'netstats']);
    currentIface = iface;
    console.log(`Preferred interface set to: ${iface}`);
  } catch (e) {
    console.error('Error setting preferred interface:', e);
  }
}


function getBestWAN(stats, preferred) {
  if (!stats || Object.keys(stats).length === 0) {
    return 'wwan0_1'; //  fallback
  }

  
  for (const iface of preferred) {
    if (stats[iface]) return iface;
  }

  const modemMatch = Object.keys(stats).find(iface =>
    /^(wwan|wwp|usb|rmnet|cdc|qmi|ppp|lte|modem|mobile|cell|tty)/i.test(iface)
  );
  if (modemMatch) return modemMatch;

  const fallback = ['pppoe-wan', 'lte0', 'usb0', 'eth1', 'wan', 'tun0', 'wg0', 'utun0'];
  for (const name of fallback) {
    if (stats[name]) return name;
  }

  const nonLo = Object.keys(stats).filter(k => k !== 'lo');
  return nonLo[0] || 'wwan0_1';
}

function formatRate(bits) {
  const units = ['Bps', 'Kbps', 'Mbps', 'Gbps'];
  let i = 0;
  
  while (bits >= 1000 && i < units.length - 1) {
    bits /= 1000;
    i++;
  }
  
  return { 
    number: bits.toFixed(i > 0 ? 1 : 0), 
    unit: units[i] + '/s' 
  };
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  
  return { 
    number: bytes.toFixed(i > 0 ? 1 : 0), 
    unit: units[i] 
  };
}


function createStatCard(label, valueNum, valueUnit, color, iface) {
  return E('div', { class: 'stats-card', style: 'box-shadow: none;' }, [
    E('div', { class: 'stat-label' }, label),
    E('div', { class: 'stat-value' }, [
      E('span', { class: 'stat-number' }, valueNum),
      E('br'),
      E('span', { class: 'stat-unit' }, valueUnit)
    ]),
    E('span', {
      class: 'iface-badge',
      style: `margin-top: 6px; display: inline-block; padding: 2px 6px; font-size: 10px; border-radius: 4px; background-color: ${color}; color: white;`
    }, iface)
  ]);
}

function createIPCard(ip, org) {
  const ipVal = E('div', { class: 'ip-value', id: 'ip-value' }, ipVisible ? ip : '**********');
  const eye = E('img', {
    src: ipVisible ? '/luci-static/resources/netstat/eye-outline.svg' : '/luci-static/resources/netstat/eye-off-outline.svg',
    class: 'eye-icon',
    title: _('Show/Hide IP')
  });

  eye.addEventListener('click', function() {
    ipVisible = !ipVisible;
    localStorage.setItem('ipVisible', ipVisible);
    ipVal.textContent = ipVisible ? ip : '**********';
    eye.src = ipVisible 
      ? '/luci-static/resources/netstat/eye-outline.svg' 
      : '/luci-static/resources/netstat/eye-off-outline.svg';
  });

  return E('div', { class: 'ip-card full-width', style: 'box-shadow: none;' }, [
    E('div', { class: 'ip-line' }, [ipVal, eye]),
    E('div', { class: 'ip-org' }, org),
    E('div', { class: 'bubble yellow' })
  ]);
}

return baseclass.extend({
  title: _(''),

  load: function() {
    return Promise.all([
      fs.read_direct('/proc/net/dev')
        .then(parseStats)
        .catch(() => ({})),
      getPublicIP(),
      getPreferredInterfaces()
    ]).then(([netStats, ipData, preferred]) => ({ 
      netStats, 
      ipData, 
      preferred 
    }));
  },

  render: function(data) {
    const now = Date.now();
    const dt = Math.max(0.1, (now - last_time) / 1000);

    const blacklist = ['lo', 'br-lan', 'docker0'];
    const filteredStats = Object.fromEntries(
      Object.entries(data.netStats).filter(([k]) => !blacklist.includes(k))
    );

    const iface = getBestWAN(filteredStats, data.preferred);
    
    if (iface && data.preferred && !data.preferred.includes(iface)) {
      setPreferredInterface(iface);
    }

    const curr = filteredStats[iface] || { rx: 0, tx: 0 };
    const prevStat = prev[iface] || curr;

    let rxSpeed = (curr.rx - prevStat.rx) / dt;
    let txSpeed = (curr.tx - prevStat.tx) / dt;

    if (!smoothed[iface]) {
      smoothed[iface] = { rx: rxSpeed, tx: txSpeed };
    } else {
      smoothed[iface].rx = smoothing * rxSpeed + (1 - smoothing) * smoothed[iface].rx;
      smoothed[iface].tx = smoothing * txSpeed + (1 - smoothing) * smoothed[iface].tx;
    }

    rxSpeed = smoothed[iface].rx;
    txSpeed = smoothed[iface].tx;

    prev[iface] = curr;
    last_time = now;

    const rxRate = formatRate(rxSpeed * 8);
    const txRate = formatRate(txSpeed * 8);
    const rxTotal = formatSize(curr.rx);
    const txTotal = formatSize(curr.tx);

    const org = data.ipData?.network?.autonomous_system?.name || 'Unknown';
    const ip = data.ipData?.ip || 'Unavailable';

    const grid = E('div', { class: 'stats-grid' });

    grid.appendChild(createStatCard(
      _('Download'), rxRate.number, rxRate.unit, '#4CAF50', iface
    ));
    grid.appendChild(createStatCard(
      _('Upload'), txRate.number, txRate.unit, '#2196F3', iface
    ));
    grid.appendChild(createStatCard(
      _('Total RX'), rxTotal.number, rxTotal.unit, '#FF9800', iface
    ));
    grid.appendChild(createStatCard(
      _('Total TX'), txTotal.number, txTotal.unit, '#9C27B0', iface
    ));


    grid.appendChild(createIPCard(ip, org));
    L.Poll.add(() => {
      return fs.read_direct('/proc/net/dev')
        .then(raw => {
          const updated = parseStats(raw);
          return this.render({ 
            netStats: updated, 
            ipData: data.ipData, 
            preferred: data.preferred 
          });
        })
        .catch(() => this.render(data));
    }, 1000);

    return E('div', {}, [grid]);
  }
});
