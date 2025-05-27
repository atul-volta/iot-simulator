let meters = [];
let meterCount = 0;
let flowCharts = {};
let totalCharts = {};
let mqttClients = {};

// ------ Utility Functions ------
function setIntervalSec(idx, val) {
  let sec = Math.max(1, parseInt(val, 10) || 1);
  meters[idx].interval = sec;

  // Update the input box in case the value was changed
  const card = document.getElementById(`meter-card-${meters[idx].id}`);
  if (card) {
    const input = card.querySelector('input[type="number"]');
    if (input) input.value = sec;
  }

  updateMeterDisplay(idx);
}

function getStatusDurationSeconds(status) {
  switch (status) {
    case "burst":        return Math.floor(Math.random() * 120) + 60;
    case "low flow":     return Math.floor(Math.random() * 600) + 300;
    case "reverse flow": return Math.floor(Math.random() * 60) + 20;
    case "outage":       return Math.floor(Math.random() * 300) + 60;
    default:             return Math.floor(Math.random() * 120) + 20;
  }
}

function getFlowRate(profile, status) {
  const hour = new Date().getHours();
  let base = 0;
  if (profile === "residential") {
    if ((hour >= 6 && hour <= 8) || (hour >= 18 && hour <= 21))
      base = Math.random() * 10 + 5;
    else if (hour >= 22 || hour <= 5)
      base = Math.random() < 0.8 ? 0 : Math.random() * 2;
    else
      base = Math.random() * 3;
  } else {
    if (hour >= 8 && hour <= 18)
      base = Math.random() * 8 + 3;
    else
      base = Math.random() < 0.9 ? 0 : Math.random() * 2;
  }
  if (status === "low flow") return Math.random() * 0.5 + 0.01;
  if (status === "burst") return base * (2.2 + Math.random() * 1.3);
  if (status === "reverse flow") return -1 * (Math.random() * 2 + 0.1);
  if (status === "outage") return 0;
  return base;
}

// ------ Meter Simulation ------
function addMeter() {
  meterCount++;
  const meterId = "WM-" + String(meterCount).padStart(3, "0");
  meters.push({
    id: meterId,
    profile: "residential",
    interval: 10,
    timer: null,
    totalVolume: 0,
    data: [],
    chartLabels: [],
    flowPoints: [],
    totalPoints: [],
    mqttEnabled: false,
    mqttBroker: "wss://broker.hivemq.com:8884/mqtt",
    mqttTopic: `iot/watermeter/${meterId}`,
    lowFlowProb: 2,
    burstProb: 1,
    reverseProb: 0.5,
    outageProb: 0.5,
    injectNext: "",
    currentStatus: "normal",
    statusDuration: 0,
    lastPhysicalStatus: "normal",
    lastStatusDuration: 0
  });
  renderMeters();
}

function removeMeter(index) {
  clearInterval(meters[index].timer);
  let meterId = meters[index].id;
  if (flowCharts[meterId]) {
    flowCharts[meterId].destroy();
    delete flowCharts[meterId];
  }
  if (totalCharts[meterId]) {
    totalCharts[meterId].destroy();
    delete totalCharts[meterId];
  }
  if (mqttClients[meterId]) {
    mqttClients[meterId].end?.();
    delete mqttClients[meterId];
  }
  meters.splice(index, 1);
  renderMeters();
}

function startMeter(index) {
  const meter = meters[index];
  if (meter.timer) return;
  generateMeterData(meter, true);
  meter.timer = setInterval(() => {
    generateMeterData(meter, false);
    updateMeterDisplay(index); // Only update table/chart/fault badge for this meter
  }, meter.interval * 1000);
  updateMeterDisplay(index);
}

function stopMeter(index) {
  clearInterval(meters[index].timer);
  meters[index].timer = null;
  updateMeterDisplay(index);
}

function injectFault(index) {
  const select = document.getElementById(`injectFault-${meters[index].id}`);
  if (select) {
    meters[index].injectNext = select.value;
    select.value = "";
  }
}

function getRandomStatus(meter) {
  const r = Math.random() * 100;
  if (r < meter.lowFlowProb) return "low flow";
  if (r < meter.lowFlowProb + meter.burstProb) return "burst";
  if (r < meter.lowFlowProb + meter.burstProb + meter.reverseProb) return "reverse flow";
  if (r < meter.lowFlowProb + meter.burstProb + meter.reverseProb + meter.outageProb) return "outage";
  return "normal";
}

function simulatePhysicalMeterReading(meter, isFirst) {
  const simulationStep = 1;
  const steps = Math.max(1, Math.floor(meter.interval / simulationStep));
  let totalFlow = 0;
  let volume = 0;
  let statuses = [];
  let status = meter.lastPhysicalStatus;
  let statusDuration = meter.lastStatusDuration;

  let injectedStatus = null;
  if (meter.injectNext) {
    injectedStatus = {
      "low flow": "low flow",
      burst: "burst",
      reverse: "reverse flow",
      outage: "outage"
    }[meter.injectNext] || "normal";
    if (injectedStatus) {
      status = injectedStatus;
      statusDuration = getStatusDurationSeconds(injectedStatus);
    }
    meter.injectNext = "";
  }

  for (let i = 0; i < steps; i++) {
    if (isFirst && i === 0 && statusDuration === 0) {
      status = "normal";
      statusDuration = getStatusDurationSeconds("normal");
    }
    if (statusDuration > 0) {
      statusDuration--;
    } else {
      status = getRandomStatus(meter);
      statusDuration = getStatusDurationSeconds(status) - 1;
    }
    let flow;
    if (status === "outage") {
      flow = 0;
    } else {
      flow = getFlowRate(meter.profile, status);
    }
    totalFlow += flow;
    volume += (flow * simulationStep) / 60;
    statuses.push(status);
  }
  let avgFlow = totalFlow / steps;
  meter.totalVolume += volume;
  const now = new Date();
  const label = now.toLocaleTimeString();
  const priority = ["burst", "reverse flow", "low flow", "outage", "normal"];
  let finalStatus = priority.find(st => statuses.includes(st)) || "normal";
  meter.lastPhysicalStatus = status;
  meter.lastStatusDuration = statusDuration;

  return {
    time: label,
    timestamp: now.toISOString(),
    flow: avgFlow,
    total: meter.totalVolume.toFixed(2),
    status: finalStatus
  };
}

function generateMeterData(meter, isFirst) {
  const reading = simulatePhysicalMeterReading(meter, isFirst);

  appendMeterData(meter, reading);
  if (meter.mqttEnabled && meter.mqttBroker && meter.mqttTopic) {
    if (!mqttClients[meter.id] || !mqttClients[meter.id].connected) {
      try {
        mqttClients[meter.id]?.end?.();
        mqttClients[meter.id] = mqtt.connect(meter.mqttBroker, { reconnectPeriod: 2000 });
        mqttClients[meter.id].on('connect', () => {
          updateMqttStatus(meter.id, "Connected");
        });
        mqttClients[meter.id].on('error', (err) => {
          updateMqttStatus(meter.id, "Error: " + err.message);
        });
        mqttClients[meter.id].on('close', () => {
          updateMqttStatus(meter.id, "Disconnected");
        });
      } catch (e) {
        updateMqttStatus(meter.id, "MQTT Error: " + e.message);
        return;
      }
    }
    const msg = {
      meter_id: meter.id,
      timestamp: reading.timestamp,
      flow_rate_lpm: reading.flow,
      total_volume_l: parseFloat(reading.total),
      status: reading.status
    };
    try {
      mqttClients[meter.id].publish(meter.mqttTopic, JSON.stringify(msg));
      updateMqttStatus(meter.id, "Published");
    } catch (e) {
      updateMqttStatus(meter.id, "Publish Error");
    }
  }
}

function appendMeterData(meter, entry) {
  meter.data.unshift({
    time: entry.time,
    flow: entry.flow,
    total: entry.total,
    status: entry.status
  });
  if (meter.chartLabels.length >= 30) {
    meter.chartLabels.pop();
    meter.flowPoints.pop();
    meter.totalPoints.pop();
  }
  meter.chartLabels.unshift(entry.time);
  meter.flowPoints.unshift(entry.flow);
  meter.totalPoints.unshift(parseFloat(entry.total));
}

function clearMeterStatus(index) {
  const meter = meters[index];
  meter.currentStatus = "normal";
  meter.statusDuration = 0;
  meter.lastPhysicalStatus = "normal";
  meter.lastStatusDuration = 0;
  renderMeters();
}

function renderMeters() {
  const metersDiv = document.getElementById("meters");
  metersDiv.innerHTML = "";
  meters.forEach((meter, idx) => {
    const meterDiv = document.createElement("div");
    meterDiv.className = "meter-card";
    meterDiv.id = `meter-card-${meter.id}`;

    // Badge & button will be dynamically added in updateFaultBadge
    meterDiv.innerHTML += `
      <div class="inline-row">
        <label><strong>Meter ID:</strong>
          <input value="${meter.id}" onchange="meters[${idx}].id=this.value; updateMeterDisplay(${idx})">
        </label>
        <label>Profile:
          <select onchange="meters[${idx}].profile=this.value; updateMeterDisplay(${idx})">
            <option value="residential" ${meter.profile==="residential"?"selected":""}>Residential</option>
            <option value="commercial" ${meter.profile==="commercial"?"selected":""}>Commercial</option>
          </select>
        </label>
        <label>Interval (sec):
          <input type="number" min="1" value="${meter.interval}" onchange="setIntervalSec(${idx}, this.value)">
        </label>
        <button class="btn-blue" onclick="startMeter(${idx})" ${meter.timer ? "disabled" : ""}>Start</button>
        <button class="btn-blue" onclick="stopMeter(${idx})" ${meter.timer ? "" : "disabled"}>Stop</button>
        <button class="btn-blue" onclick="removeMeter(${idx})">Remove</button>
      </div>
      <div class="collapsible-section">
        <button class="collapsible-toggle" type="button" aria-expanded="false">
          <span class="chevron">&#9654;</span>
          MQTT Settings <small style="font-weight:normal;margin-left:0.5em;">(optional)</small>
        </button>
        <div class="collapsible-content">
          <div class="inline-row">
            <label>Broker URL:
              <input type="text" value="${meter.mqttBroker}" onchange="meters[${idx}].mqttBroker=this.value">
            </label>
            <label>Topic:
              <input type="text" value="${meter.mqttTopic}" onchange="meters[${idx}].mqttTopic=this.value">
            </label>
            <label style="margin-right:0;">
              <input type="checkbox" ${meter.mqttEnabled ? "checked" : ""} onchange="meters[${idx}].mqttEnabled=this.checked">
              Enable
            </label>
          </div>
          <div class="form-row">
            <span>MQTT Export</span>
            <span id="mqttStatus-${meter.id}" class="mqtt-status"></span>
          </div>
        </div>
      </div>
      <div class="collapsible-section">
        <button class="collapsible-toggle" type="button" aria-expanded="false">
          <span class="chevron">&#9654;</span>
          Status Anomaly Probabilities & Fault Injection
        </button>
        <div class="collapsible-content">
          <div class="inline-row">
            <label>Low Flow (%):
              <input type="number" min="0" max="100" step="0.1" value="${meter.lowFlowProb}" onchange="meters[${idx}].lowFlowProb=parseFloat(this.value)">
            </label>
            <label>Burst (%):
              <input type="number" min="0" max="100" step="0.1" value="${meter.burstProb}" onchange="meters[${idx}].burstProb=parseFloat(this.value)">
            </label>
            <label>Reverse Flow (%):
              <input type="number" min="0" max="100" step="0.1" value="${meter.reverseProb}" onchange="meters[${idx}].reverseProb=parseFloat(this.value)">
            </label>
            <label>Outage (%):
              <input type="number" min="0" max="100" step="0.1" value="${meter.outageProb || 0}" onchange="meters[${idx}].outageProb=parseFloat(this.value)">
            </label>
          </div>
          <div class="form-row">
            <label>Inject Fault: 
              <select id="injectFault-${meter.id}">
                <option value="">-- select --</option>
                <option value="low flow">low flow</option>
                <option value="burst">burst</option>
                <option value="reverse">reverse flow</option>
                <option value="outage">outage</option>
              </select>
            </label>
            <button class="btn-blue" onclick="injectFault(${idx})">Inject</button>
            <span style="color:#c47817;font-size:0.98em;">(injects for next reading)</span>
          </div>
        </div>
      </div>
      <div class="export-btns">
        <button class="btn-blue" onclick="exportCSV(${idx})">Export CSV</button>
        <button class="btn-blue" onclick="exportJSON(${idx})">Export JSON</button>
      </div>
      <div class="chart-container">
        <div>
          <small>Flow Rate (L/min)</small>
          <canvas id="flowChart-${meter.id}" width="280" height="110"></canvas>
        </div>
        <div>
          <small>Total Volume (L)</small>
          <canvas id="totalChart-${meter.id}" width="280" height="110"></canvas>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Flow Rate</th>
            <th>Total Volume</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="readings-${meter.id}">
          <!-- readings will be filled dynamically -->
        </tbody>
      </table>
    `;
    metersDiv.appendChild(meterDiv);

    // --- Destroy any old charts and re-create, then update data ---
    setTimeout(() => {
      if (flowCharts[meter.id]) {
        flowCharts[meter.id].destroy();
        flowCharts[meter.id] = null;
      }
      if (totalCharts[meter.id]) {
        totalCharts[meter.id].destroy();
        totalCharts[meter.id] = null;
      }
      const flowCanvas = document.getElementById(`flowChart-${meter.id}`);
      const totalCanvas = document.getElementById(`totalChart-${meter.id}`);
      flowCharts[meter.id] = new Chart(flowCanvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: meter.chartLabels.slice().reverse(),
          datasets: [{
            label: 'Flow Rate',
            data: meter.flowPoints.slice().reverse(),
            fill: false,
            borderColor: 'rgba(50,102,244,0.8)',
            tension: 0.3,
          }]
        },
        options: {
          animation: false,
          plugins: { legend: { display: false }},
          scales: { x: { display: false }, y: { beginAtZero: true } }
        }
      });
      totalCharts[meter.id] = new Chart(totalCanvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: meter.chartLabels.slice().reverse(),
          datasets: [{
            label: 'Total Volume',
            data: meter.totalPoints.slice().reverse(),
            fill: true,
            borderColor: 'rgba(61,184,116,0.9)',
            backgroundColor: 'rgba(61,184,116,0.12)',
            tension: 0.3,
          }]
        },
        options: {
          animation: false,
          plugins: { legend: { display: false }},
          scales: { x: { display: false }, y: { beginAtZero: true } }
        }
      });
      updateMeterDisplay(idx);
    }, 0);
  });
}

function updateMeterDisplay(idx) {
  const meter = meters[idx];
  // Update chart data
  if (flowCharts[meter.id]) {
    flowCharts[meter.id].data.labels = meter.chartLabels.slice().reverse();
    flowCharts[meter.id].data.datasets[0].data = meter.flowPoints.slice().reverse();
    flowCharts[meter.id].update();
  }
  if (totalCharts[meter.id]) {
    totalCharts[meter.id].data.labels = meter.chartLabels.slice().reverse();
    totalCharts[meter.id].data.datasets[0].data = meter.totalPoints.slice().reverse();
    totalCharts[meter.id].update();
  }
  updateTableRows(meter);

  // Update start/stop buttons
  const card = document.getElementById(`meter-card-${meter.id}`);
  if (card) {
    const startBtn = card.querySelector('button[onclick^="startMeter"]');
    const stopBtn = card.querySelector('button[onclick^="stopMeter"]');
    if (startBtn) startBtn.disabled = !!meter.timer;
    if (stopBtn) stopBtn.disabled = !meter.timer;
  }

  // --- Fault badge/button update ---
  updateFaultBadge(idx);
}

function updateFaultBadge(idx) {
  const meter = meters[idx];
  const card = document.getElementById(`meter-card-${meter.id}`);
  if (!card) return;
  // Remove old badge/button if they exist
  const oldBadge = card.querySelector('.offline-badge');
  if (oldBadge) oldBadge.remove();
  const oldExitBtn = card.querySelector('.exit-status-btn');
  if (oldExitBtn) oldExitBtn.remove();
  // If meter is in fault, add badge and manual exit button
  if (["burst", "low flow", "reverse flow", "outage"].includes(meter.lastPhysicalStatus) && meter.lastStatusDuration > 0) {
    const statusBadge = document.createElement("div");
    statusBadge.className = "offline-badge";
    statusBadge.innerHTML = `${meter.lastPhysicalStatus.toUpperCase()}<br><small>Manual exit available</small>`;
    card.insertBefore(statusBadge, card.firstChild);
    const exitBtn = document.createElement("button");
    exitBtn.className = "btn-blue exit-status-btn";
    exitBtn.style.marginBottom = "1em";
    exitBtn.innerText = "Exit Status";
    exitBtn.onclick = () => clearMeterStatus(idx);
    card.insertBefore(exitBtn, statusBadge.nextSibling);
  }
}

function updateTableRows(meter) {
  const tbody = document.getElementById(`readings-${meter.id}`);
  if (!tbody) return;
  tbody.innerHTML = meter.data.slice(0,5).map(d => `
    <tr>
      <td>${d.time}</td>
      <td>${(d.flow === null || d.flow === undefined) ? '' : d.flow.toFixed(2)}</td>
      <td>${d.total}</td>
      <td>${d.status}</td>
    </tr>
  `).join("");
}

function updateMqttStatus(meterId, msg) {
  const el = document.getElementById("mqttStatus-" + meterId);
  if (el) el.textContent = msg;
}

function exportCSV(index) {
  const meter = meters[index];
  if (!meter || meter.data.length === 0) return;
  const headers = ["Timestamp", "Flow Rate (L/min)", "Total Volume (L)", "Status"];
  const rows = meter.data.map(d => [d.time, (d.flow === null || d.flow === undefined) ? '' : d.flow.toFixed(2), d.total, d.status]);
  let csvContent = headers.join(",") + "\n" +
    rows.map(e => e.join(",")).join("\n");
  const blob = new Blob([csvContent], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `${meter.id}_data.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
function exportJSON(index) {
  const meter = meters[index];
  if (!meter || meter.data.length === 0) return;
  const blob = new Blob([JSON.stringify(meter.data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `${meter.id}_data.json`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded', function() {
  renderMeters();
  document.body.addEventListener('click', function(event) {
    if (event.target.classList.contains('collapsible-toggle') || event.target.closest('.collapsible-toggle')) {
      const btn = event.target.closest('.collapsible-toggle');
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', (!expanded).toString());
    }
  });
});

window.addMeter = addMeter;
window.startMeter = startMeter;
window.stopMeter = stopMeter;
window.removeMeter = removeMeter;
window.exportCSV = exportCSV;
window.exportJSON = exportJSON;
window.injectFault = injectFault;
window.setIntervalSec = setIntervalSec;
window.clearMeterStatus = clearMeterStatus;
window.updateMeterDisplay = updateMeterDisplay;

addMeter();
