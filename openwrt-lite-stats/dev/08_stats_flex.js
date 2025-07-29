'use strict';
'require baseclass';
'require fs';

let prev = {};
let last_time = Date.now();
let ipVisible = localStorage.getItem('ipVisible') !== 'false';

(function loadDynamicCSS() {
  function isDarkMode() {
    const bgColor = getComputedStyle(document.body).backgroundColor;
    if (!bgColor) return false;
    const rgb = bgColor.match(/\d+/g);
    if (!rgb) return false;
    const [r, g, b] = rgb.map(Number);
    return (r * 299 + g * 587 + b * 114) / 1000 < 100;
  }

  const dark = isDarkMode();
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = dark ? '/luci-static/resources/netstat/netstat_dark.css' : '/luci-static/resources/netstat/netstat.css';
  document.head.appendChild(link);
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
}

function getPreferredInterfaces() {
  return fs.exec('/sbin/uci', ['get', 'netstats.@config[0].prefer'])
    .then(res => res.stdout.trim().split(/\s+/))
    .catch(() => []);
}

function getBestWAN(stats, preferred) {
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

  const keys = Object.keys(stats);
  if (keys.length === 1 && keys[0] === 'lo') return 'wwan0_1';

  const nonLo = keys.filter(k => k !== 'lo');
  return nonLo[0] || 'wwan0_1';
}

function formatRate(bits) {
  const units = ['Bps', 'Kbps', 'Mbps', 'Gbps'];
  let i = 0;
  while (bits >= 1000 && i < units.length - 1) {
    bits /= 1000;
    i++;
  }
  return { number: bits.toFixed(1), unit: units[i] + '/s' };
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return { number: bytes.toFixed(1), unit: units[i] };
}

return baseclass.extend({
  title: '',

  load: function () {
    return Promise.all([
      fs.read_direct('/proc/net/dev').then(parseStats).catch(() => ({})),
      getPublicIP(),
      getPreferredInterfaces()
    ]).then(([netStats, ipData, preferred]) => ({ netStats, ipData, preferred }));
  },

  render: function (data) {
    const now = Date.now();
    const dt = (now - last_time) / 1000;

    const blacklist = ['lo', 'br-lan', 'docker0'];
    const filteredStats = Object.fromEntries(
      Object.entries(data.netStats).filter(([k]) => !blacklist.includes(k))
    );

    const iface = getBestWAN(filteredStats, data.preferred);

    const curr = filteredStats[iface] || { rx: 0, tx: 0 };
    const prevStat = prev[iface] || curr;

    const rxSpeed = (curr.rx - prevStat.rx) / dt;
    const txSpeed = (curr.tx - prevStat.tx) / dt;

    prev[iface] = curr;
    last_time = now;

    const rxRate = formatRate(rxSpeed * 8);
    const txRate = formatRate(txSpeed * 8);
    const rxTotal = formatSize(curr.rx);
    const txTotal = formatSize(curr.tx);

    const org = data.ipData?.network?.autonomous_system?.name?.replace(/^AS\d+\s*/, '') || 'Unknown';
    const ip = data.ipData?.ip || 'Unavailable';

    const stats = [
      { label: _('Download'), valueNum: rxRate.number, valueUnit: rxRate.unit, color: '#4CAF50' },
      { label: _('Upload'), valueNum: txRate.number, valueUnit: txRate.unit, color: '#2196F3' },
      { label: _('Total RX'), valueNum: rxTotal.number, valueUnit: rxTotal.unit, color: '#FF9800' },
      { label: _('Total TX'), valueNum: txTotal.number, valueUnit: txTotal.unit, color: '#9C27B0' }
    ];

    const grid = E('div', { class: 'stats-grid' });

    stats.forEach(stat => {
      grid.appendChild(E('div', { class: 'stats-card', style: 'box-shadow: none;' }, [
        E('div', { class: 'stat-label' }, stat.label),
        E('div', { class: 'stat-value' }, [
          E('span', { class: 'stat-number' }, stat.valueNum),
          E('br'),
          E('span', { class: 'stat-unit' }, stat.valueUnit)
        ]),
        E('span', {
          class: 'iface-badge',
          style: `margin-top: 6px; display: inline-block; padding: 2px 6px; font-size: 10px; border-radius: 4px; background-color: ${stat.color}; color: white;`
        }, iface)
      ]));
    });

    const ipVal = E('div', { class: 'ip-value', id: 'ip-value' }, ipVisible ? ip : '**********');
    const eye = E('img', {
      src: ipVisible ? '/luci-static/resources/netstat/eye-outline.svg' : '/luci-static/resources/netstat/eye-off-outline.svg',
      class: 'eye-icon',
      title: _('Show/Hide IP')
    });

    eye.addEventListener('click', function () {
      ipVisible = !ipVisible;
      localStorage.setItem('ipVisible', ipVisible);
      ipVal.textContent = ipVisible ? ip : '**********';
      eye.src = ipVisible ? '/luci-static/resources/netstat/eye-outline.svg' : '/luci-static/resources/netstat/eye-off-outline.svg';
    });

    grid.appendChild(E('div', { class: 'ip-card full-width', style: 'box-shadow: none;' }, [
      E('div', { class: 'ip-line' }, [ipVal, eye]),
      E('div', { class: 'ip-org' }, org),
      E('div', { class: 'bubble yellow' })
    ]));

    L.Poll.add(() => {
      return fs.read_direct('/proc/net/dev').then(raw => {
        const updated = parseStats(raw);
        return this.render({ netStats: updated, ipData: data.ipData, preferred: data.preferred });
      });
    }, 1000);

    return E('div', {}, [grid]);
  }
});
