import { exec, spawn, toast } from "kernelsu";

const LOG_DIR = "/data/local/tmp/chroot-distro-logs";
const SETTINGS_PATH = "/data/local/chroot-distro/data/settings.conf";
const DISTRO_SETTINGS_DIR = "/data/local/chroot-distro/data/distro_settings";
const mainContent = document.getElementById("main-content");
const settingsView = document.getElementById("settings-view");
const versionText = document.getElementById("version-text");
const toastEl = document.getElementById("toast");
const maintainerCredit = document.getElementById("maintainer-credit");
const navHome = document.getElementById("nav-home");
const navSettings = document.getElementById("nav-settings");

const helpBtn = document.getElementById("help-btn");
const clearCacheBtn = document.getElementById("clear-cache-btn");
const helpModal = document.getElementById("help-modal");
const closeHelpModalBtn = document.getElementById("close-help-modal");
const helpContent = document.getElementById("help-content");
const searchContainer = document.getElementById("search-container");
const titleContainer = document.getElementById("title-container");
const searchInput = document.getElementById("search-input");
const searchCloseBtn = document.getElementById("search-close-btn");
const searchBtn = document.getElementById("search-btn");

let allDistros = [];
let currentSortOrder = "az";

const activeTerminals = new Map();
const activeWatchers = new Map();

/**
 * Get log path for distro action
 * @param {string} distroName
 * @param {string} action
 * @returns {string}
 */
function getLogPath(distroName, action) {
	return `${LOG_DIR}/${distroName}_${action}.log`;
}

/**
 * Save active task to localStorage
 * @param {string} distro
 * @param {string} action
 */
function saveActiveTask(distro, action) {
	const tasks = JSON.parse(localStorage.getItem("active_tasks") || "{}");
	tasks[distro] = { action, timestamp: Date.now() };
	localStorage.setItem("active_tasks", JSON.stringify(tasks));
}

/**
 * Remove active task from localStorage
 * @param {string} distro
 */
function removeActiveTask(distro) {
	const tasks = JSON.parse(localStorage.getItem("active_tasks") || "{}");
	delete tasks[distro];
	localStorage.setItem("active_tasks", JSON.stringify(tasks));
}

/**
 * Start watching log file and updating terminal
 * @param {string} distroName
 * @param {string} filePath
 * @param {HTMLElement} terminalOutput
 * @param {Function} onFinish
 */
async function startLogWatcher(distroName, filePath, terminalOutput, onFinish) {
	if (activeWatchers.has(distroName)) return;

	let offset = 0;
	let finishCheckCount = 0;
	const interval = setInterval(async () => {
		try {
			const { stdout } = await exec(`cat "${filePath}"`);

			if (stdout && stdout.length > offset) {
				const newContent = stdout.slice(offset);
				offset = stdout.length;
				appendTerminalLine(terminalOutput, newContent);
				finishCheckCount = 0; // Reset finish check if data is flowing
			} else {
				finishCheckCount++;
			}

			// Check if process is still running if we haven't seen data for a while
			// This is a "watchdog" style check.
			if (finishCheckCount > 10) {
				// Every 1s * 10 = 10s of no data.
				// We rely on the caller to clear the interval via onFinish or external check usually.
				// But for restored sessions, we need to know when to stop.
				const isRunning = await isProcessRunning(distroName);
				if (!isRunning) {
					clearInterval(interval);
					activeWatchers.delete(distroName);
					if (onFinish) onFinish(); // Logic to finalize UI
				}
				finishCheckCount = 0;
			}
		} catch (e) {
			// File might not exist yet or error reading
			console.warn("Log watcher error:", e);
		}
	}, 1000);

	activeWatchers.set(distroName, interval);
}

/**
 * Check if a chroot-distro process for the distro is running
 * @param {string} distroName
 * @returns {Promise<boolean>}
 */
async function isProcessRunning(distroName) {
	// Check for direct chroot-distro process or wrapper script
	const { stdout } = await exec(`ps -ef | grep -E "(chroot-distro.*(install|remove|unmount).*${distroName}|${distroName}_(install|uninstall|stop)\\.sh)" | grep -v grep`);
	return !!stdout && stdout.trim().length > 0;
}

/**
 * Show toast message
 * @param {string} message
 * @param {boolean} isError
 */
function showToast(message, isError = false) {
	try {
		toast(message);
	} catch (e) {
		toastEl.textContent = message;
		toastEl.classList.toggle("error", isError);
		toastEl.classList.add("show");
		setTimeout(() => {
			toastEl.classList.remove("show");
		}, 3000);
	}
}

/**
 * Apply ripple effect to element
 * @param {HTMLElement} element
 */
function applyRipple(element) {
	element.addEventListener("click", function (e) {
		const rect = element.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;

		const ripple = document.createElement("span");
		ripple.className = "ripple";
		ripple.style.left = x + "px";
		ripple.style.top = y + "px";

		element.appendChild(ripple);
		setTimeout(() => ripple.remove(), 600);
	});
}

/**
 * Append line to terminal
 * @param {HTMLElement} terminalOutput
 * @param {string} text
 * @param {string} type 'normal', 'error', 'success'
 */
function appendTerminalLine(terminalOutput, text, type = "normal") {
	if (!text) return;
	const lines = text.split("\n");
	lines.forEach((line) => {
		if (line.trim() === "") return;
		const div = document.createElement("div");
		div.className = `terminal-line ${type}`;
		div.textContent = line;
		terminalOutput.appendChild(div);
	});
	terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

/**
 * Fetch version info
 */
async function fetchVersion() {
	try {
		const { errno, stdout } = await exec("JOSINIFY=true chroot-distro --version");
		if (errno === 0 && stdout) {
			const data = JSON.parse(stdout.trim());
			versionText.textContent = `v${data.version}`;
			if (data.maintainer) {
				maintainerCredit.textContent = `Created by ${data.maintainer}`;
			}
		}
	} catch (e) {
		console.error("Failed to fetch version:", e);
	}
}

/**
 * Fetch distributions list with running status
 * @returns {Promise<Array>}
 */
async function fetchDistros() {
	const listPromise = exec("JOSINIFY=true chroot-distro list");
	const runningPromise = exec("JOSINIFY=true chroot-distro list-running");

	const [listResult, runningResult] = await Promise.all([listPromise, runningPromise]);

	if (listResult.errno !== 0) {
		throw new Error(listResult.stderr || "Failed to fetch distributions");
	}

	const listData = JSON.parse(listResult.stdout.trim());
	let runningNames = [];

	if (runningResult.errno === 0 && runningResult.stdout) {
		try {
			const runningData = JSON.parse(runningResult.stdout.trim());
			if (runningData.running_distributions) {
				runningNames = runningData.running_distributions.map((d) => d.name);
			}
		} catch (e) {
			console.warn("Failed to parse running distros:", e);
		}
	}

	return (listData.distributions || []).map((d) => ({
		...d,
		running: runningNames.includes(d.name),
	}));
}

/**
 * Sync active tasks with UI (restore sessions)
 */
async function syncActiveTasksUI() {
	const tasks = JSON.parse(localStorage.getItem("active_tasks") || "{}");
	const distros = Object.keys(tasks);

	for (const distro of distros) {
		const task = tasks[distro];
		const card = document.getElementById(`card-${distro}`);
		if (!card) continue;

		// Visual state update
		const btn = card.querySelector(`.action-btn[data-action="${task.action}"]`);

		if (task.action === "install" || task.action === "uninstall") {
			if (btn) btn.disabled = true;

			// Add animation to button icon
			const btnIcon = btn ? btn.querySelector("svg") : null;
			if (btnIcon) {
				if (task.action === "install") {
					btnIcon.classList.add("download-anim");
				} else {
					btnIcon.classList.add("shake-anim");
				}
			}

			// Open terminal
			const terminal = card.querySelector(`#terminal-${distro}`);
			if (!terminal) continue;

			toggleTerminal(distro, card);

			const terminalOutput = terminal.querySelector(".terminal-output");
			const terminalTitle = terminal.querySelector(".terminal-title span");
			const closeBtn = terminal.querySelector(".terminal-close-btn");

			if (closeBtn) closeBtn.disabled = true;
			if (!terminal.classList.contains("open")) terminal.classList.add("open");
			terminalOutput.innerHTML = ""; // Clear "No recent logs"

			const logPath = getLogPath(distro, task.action);
			terminalTitle.textContent = `${task.action === "install" ? "Installing" : "Removing"} ${distro}...`;

			const isRunning = await isProcessRunning(distro);

			if (activeWatchers.has(distro)) {
				clearInterval(activeWatchers.get(distro));
				activeWatchers.delete(distro);
			}

			if (isRunning) {
				startLogWatcher(distro, logPath, terminalOutput, async () => {
					await handleTaskCompletion(distro, task.action, card, terminal, terminalTitle, terminalOutput, btn, closeBtn);
					if (btnIcon) btnIcon.classList.remove("download-anim", "shake-anim");
				});
			} else {
				const { stdout } = await exec(`cat "${logPath}"`);
				if (stdout) appendTerminalLine(terminalOutput, stdout);
				await handleTaskCompletion(distro, task.action, card, terminal, terminalTitle, terminalOutput, btn, closeBtn);
				if (btnIcon) btnIcon.classList.remove("download-anim", "shake-anim");
			}
		}
	}
}

/**
 * Handle task completion logic
 */
async function handleTaskCompletion(distroName, action, card, terminal, terminalTitle, terminalOutput, btn, closeBtn) {
	activeWatchers.delete(distroName); // Ensure watcher is gone
	removeActiveTask(distroName);

	const { errno, stdout } = await exec("JOSINIFY=true chroot-distro list");
	let success = false;
	if (errno === 0 && stdout) {
		const data = JSON.parse(stdout.trim());
		const distroInfo = data.distributions?.find((d) => d.name === distroName);
		if (action === "install") success = distroInfo?.installed === true;
		if (action === "uninstall") success = distroInfo?.installed === false;
	}

	if (success) {
		terminalTitle.textContent = `${distroName} ${action === "install" ? "installed" : "removed"} successfully!`;
		terminalTitle.style.color = "#4ade80";
		appendTerminalLine(terminalOutput, `✓ ${action === "install" ? "Installation" : "Removal"} completed successfully!`, "success");
		showToast(`${distroName} ${action === "install" ? "installed" : "removed"} successfully!`);

		setTimeout(async () => {
			terminal.classList.remove("open");
			if (closeBtn) closeBtn.disabled = false;
			if (btn) btn.disabled = false;
			await refreshDistroCard(distroName, card);
		}, 3000);
	} else {
		terminalTitle.textContent = "Operation failed (or checking failed)";
		terminalTitle.style.color = "#e94560";
		appendTerminalLine(terminalOutput, "✗ Operation failed.", "error");
		if (closeBtn) closeBtn.disabled = false;
		if (btn) btn.disabled = false;
	}
}

/**
 * Switch to specific view
 * @param {string} view 'home' or 'settings'
 */
function switchView(view) {
	if (view === "home") {
		mainContent.classList.remove("hidden");
		settingsView.classList.add("hidden");
		navHome.classList.add("active");
		navSettings.classList.remove("active");
		// Optional: refresh home data
	} else if (view === "settings") {
		mainContent.classList.add("hidden");
		settingsView.classList.remove("hidden");
		navHome.classList.remove("active");
		navSettings.classList.add("active");
		loadSettings();
	}
}

/**
 * Show Help Modal
 */
async function showHelp() {
	const originalText = helpBtn.querySelector("span").textContent;
	helpBtn.querySelector("span").textContent = "Loading...";
	helpBtn.disabled = true;

	try {
		const { errno, stdout, stderr } = await exec("export JOSINIFY=true && chroot-distro --help");

		let content = "";
		let json = null;

		if (stdout) {
			try {
				json = JSON.parse(stdout);
			} catch (e) {
				content = stdout;
			}
		}

		if (json && json.commands) {
			// Format as table
			const table = document.createElement("div");
			table.className = "help-table";

			json.commands.forEach((cmd) => {
				const row = document.createElement("div");
				row.className = "help-row";

				const cmdName = document.createElement("div");
				cmdName.className = "help-cmd";
				cmdName.textContent = cmd.name;

				const cmdDesc = document.createElement("div");
				cmdDesc.className = "help-desc";
				cmdDesc.textContent = cmd.description || "No description available";

				row.appendChild(cmdName);
				row.appendChild(cmdDesc);
				table.appendChild(row);
			});

			helpContent.innerHTML = "";
			helpContent.appendChild(table);
		} else {
			// Fallback to text
			if (stderr) content += "\n" + stderr;
			helpContent.textContent = content || "No output returned.";
		}

		helpModal.classList.add("open");
	} catch (e) {
		showToast("Failed to run help command", true);
		console.error(e);
	} finally {
		helpBtn.querySelector("span").textContent = originalText;
		helpBtn.disabled = false;
	}
}

/**
 * Clear Cache with Terminal Output
 */
async function clearCache() {
	let terminal = document.getElementById("cache-terminal");
	if (!terminal) {
		const container = document.createElement("div");
		container.innerHTML = createTerminalHTML("cache-clear");
		terminal = container.firstElementChild;
		terminal.id = "cache-terminal";

		const placeholder = document.getElementById("cache-terminal-container");
		if (placeholder) {
			placeholder.appendChild(terminal);
		} else {
			document.querySelector(".settings-container").appendChild(terminal);
		}
	}

	const terminalOutput = terminal.querySelector(".terminal-output");
	const terminalTitle = terminal.querySelector(".terminal-title span");
	const closeBtn = terminal.querySelector(".terminal-close-btn");

	if (terminal.classList.contains("open")) {
		terminal.classList.remove("open");
		return;
	}

	terminal.classList.add("open");
	terminalOutput.innerHTML = "";
	terminalTitle.textContent = "Clearing Cache...";

	closeBtn.onclick = () => {
		terminal.classList.remove("open");
	};

	appendTerminalLine(terminalOutput, "$ chroot-distro clear-cache");

	try {
		const process = spawn("chroot-distro", ["clear-cache"]);

		process.stdout.on("data", (data) => {
			appendTerminalLine(terminalOutput, data.toString());
		});

		process.stderr.on("data", (data) => {
			appendTerminalLine(terminalOutput, data.toString(), "error");
		});

		const exitCode = await new Promise((resolve) => {
			process.on("exit", (code) => resolve(code));
			process.on("error", (err) => {
				appendTerminalLine(terminalOutput, `Error: ${err.message}`, "error");
				resolve(1);
			});
		});

		if (exitCode === 0) {
			terminalTitle.textContent = "Cache Cleared";
			terminalTitle.style.color = "#4ade80";
			appendTerminalLine(terminalOutput, "✓ Success", "success");
		} else {
			terminalTitle.textContent = "Failed";
			terminalTitle.style.color = "#e94560";
		}
	} catch (e) {
		appendTerminalLine(terminalOutput, `Error: ${e.message}`, "error");
	}
}

/**
 * Create terminal HTML
 * @param {string} distroName
 * @returns {string}
 */
function createTerminalHTML(distroName) {
	return `
        <div class="terminal-container" id="terminal-${distroName}">
            <div class="terminal-header">
                <div class="terminal-title">
                    <span>Terminal - ${distroName}</span>
                </div>
                <button class="terminal-close-btn" title="Close terminal">✕</button>
            </div>
            <div class="terminal-output"><div class="terminal-line" style="color: #666;">No recent logs</div></div>
        </div>
    `;
}

/**
 * Create command dropdown HTML
 * @param {string} distroName
 * @returns {string}
 */
function createCommandDropdownHTML(distroName) {
	// Will be updated with actual command when card is rendered
	const command = `chroot-distro login ${distroName}`;
	return `
        <div class="command-dropdown" id="command-${distroName}">
            <div class="command-content">
                <span class="command-text" id="command-text-${distroName}">${command}</span>
                <button class="copy-btn" data-command="${command}" data-distro="${distroName}">Copy</button>
            </div>
        </div>
    `;
}

const ICONS = {
	install: `<svg viewBox="0 0 24 24" class="btn-icon"><path d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z"/></svg>`,
	start: `<svg viewBox="0 0 24 24" class="btn-icon"><path d="M8,5.14V19.14L19,12.14L8,5.14Z"/></svg>`,
	uninstall: `<svg viewBox="0 0 24 24" class="btn-icon"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>`,
	stop: `<svg viewBox="0 0 24 24" class="btn-icon"><path d="M18,18H6V6H18V18Z"/></svg>`,
	settings: `<svg viewBox="0 0 24 24" class="btn-icon"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .43-.17.47-.41l.36-2.54c.59-.24 1.13-.57 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.08-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`,
};

/**
 * Create distro card element
 * @param {Object} distro
 * @returns {HTMLElement}
 */
function createDistroCard(distro) {
	const card = document.createElement("div");
	card.className = "distro-card";
	card.id = `card-${distro.name}`;

	const isInstalled = distro.installed;
	const isRunning = distro.running;

	let buttonsHTML = "";
	if (isInstalled) {
		buttonsHTML = `
            <div class="btn-container">
                <button class="action-btn start ripple-element icon-btn" data-distro="${distro.name}" data-action="start" title="Start / Copy Login Command">${ICONS.start}</button>
                ${isRunning ? `<button class="action-btn stop ripple-element icon-btn" data-distro="${distro.name}" data-action="stop" title="Stop / Unmount">${ICONS.stop}</button>` : ""}
                <button class="action-btn ripple-element icon-btn" data-distro="${distro.name}" data-action="settings" title="Login Settings">${ICONS.settings}</button>
                <button class="action-btn uninstall ripple-element icon-btn" data-distro="${distro.name}" data-action="uninstall" title="Uninstall">${ICONS.uninstall}</button>
            </div>
        `;
	} else {
		buttonsHTML = `
            <button class="action-btn ripple-element icon-btn" data-distro="${distro.name}" data-action="install" title="Install">${ICONS.install}</button>
        `;
	}

	card.innerHTML = `
        <div class="distro-card-content" data-distro="${distro.name}">
            <div class="distro-info">
                <span class="distro-name">
                    ${distro.name}
                    ${distro.version ? `<span class="distro-version">[${distro.version}]</span>` : ""}
                </span>
                <div class="status-row">
                    <span class="distro-status ${isInstalled ? "installed" : ""}">
                        <span class="status-dot ${isInstalled ? "installed" : ""}"></span>
                        ${isInstalled ? "Installed" : "Not installed"}
                    </span>
                    ${
						isRunning
							? `
                    <span class="distro-status running">
                        <span class="status-dot running"></span>
                        Running
                    </span>`
							: ""
					}
                </div>
            </div>
            ${buttonsHTML}
        </div>
        ${isInstalled ? createCommandDropdownHTML(distro.name) : ""}
        ${createTerminalHTML(distro.name)}
    `;

	const cardContent = card.querySelector(".distro-card-content");

	card.querySelectorAll(".action-btn").forEach((btn) => {
		applyRipple(btn);
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			const action = btn.dataset.action;
			handleAction(distro.name, action, btn, card);
		});
	});

	const copyBtn = card.querySelector(".copy-btn");
	if (copyBtn) {
		copyBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			copyToClipboard(copyBtn.dataset.command);
		});
	}

	cardContent.addEventListener("click", (e) => {
		if (!e.target.closest(".action-btn") && !e.target.closest(".copy-btn")) {
			toggleDropdowns(distro.name, card, isInstalled);
		}
	});

	const closeBtn = card.querySelector(".terminal-close-btn");
	closeBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		closeTerminal(distro.name, card);
	});

	return card;
}

/**
 * Copy text to clipboard
 * @param {string} text
 */
async function copyToClipboard(text) {
	try {
		await navigator.clipboard.writeText(text);
		showToast("Command copied to clipboard!");
	} catch (e) {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		document.body.appendChild(textarea);
		textarea.select();
		document.execCommand("copy");
		document.body.removeChild(textarea);
		showToast("Command copied to clipboard!");
	}
}

/**
 * Toggle dropdowns (command dropdown for installed, terminal for not installed)
 * @param {string} distroName
 * @param {HTMLElement} card
 * @param {boolean} isInstalled
 */
function toggleDropdowns(distroName, card, isInstalled) {
	if (isInstalled) {
		const commandDropdown = card.querySelector(`#command-${distroName}`);
		if (commandDropdown) {
			commandDropdown.classList.toggle("open");
		}
	} else {
		toggleTerminal(distroName, card);
	}
}

/**
 * Toggle terminal visibility for distro
 * @param {string} distroName
 * @param {HTMLElement} card
 */
function toggleTerminal(distroName, card) {
	const terminal = card.querySelector(`#terminal-${distroName}`);
	if (terminal) {
		terminal.classList.toggle("open");
		if (terminal.classList.contains("open")) {
			setTimeout(() => {
				terminal.scrollIntoView({ behavior: "smooth", block: "nearest" });
			}, 100);
		}
	}
}

/**
 * Close terminal for distro
 * @param {string} distroName
 * @param {HTMLElement} card
 */
function closeTerminal(distroName, card) {
	const terminal = card.querySelector(`#terminal-${distroName}`);
	if (terminal) {
		terminal.classList.remove("open");
	}
}

// ── User Setup Modal ──────────────────────────────────────────────────

let pendingInstall = null; // { distroName, btn, card }

/**
 * Escape a string for safe use inside single-quoted shell arguments.
 * Replaces every ' with '\'' (end quote, escaped quote, reopen quote).
 * @param {string} str
 * @returns {string}
 */
function shellEscape(str) {
	return str.replace(/'/g, "'\\''");
}

/**
 * Show the user-setup modal before installing a distro.
 * @param {string} distroName
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} card
 */
function showUserSetupModal(distroName, btn, card) {
	pendingInstall = { distroName, btn, card };

	const modal = document.getElementById("user-setup-modal");
	const form = document.getElementById("user-setup-form");
	form.reset();

	// Clear previous errors
	document.getElementById("username-error").textContent = "";
	document.getElementById("password-error").textContent = "";
	document.getElementById("confirm-password-error").textContent = "";

	modal.classList.add("open");
}

/**
 * Close the user-setup modal and clear pending state.
 */
function closeUserSetupModal() {
	const modal = document.getElementById("user-setup-modal");
	modal.classList.remove("open");
	pendingInstall = null;
}

/**
 * Validate the user setup form and start installation.
 * @param {Event} e - form submit event
 */
async function validateAndInstall(e) {
	e.preventDefault();

	const username = document.getElementById("setup-username").value.trim();
	const password = document.getElementById("setup-password").value;
	const confirmPassword = document.getElementById("setup-confirm-password").value;

	const usernameError = document.getElementById("username-error");
	const passwordError = document.getElementById("password-error");
	const confirmError = document.getElementById("confirm-password-error");

	// Reset errors
	usernameError.textContent = "";
	passwordError.textContent = "";
	confirmError.textContent = "";

	let valid = true;

	if (!username) {
		usernameError.textContent = "Username is required";
		valid = false;
	} else if (/\s/.test(username)) {
		usernameError.textContent = "Username must not contain spaces";
		valid = false;
	}

	if (!password) {
		passwordError.textContent = "Password is required";
		valid = false;
	}

	if (password !== confirmPassword) {
		confirmError.textContent = "Passwords do not match";
		valid = false;
	}

	if (!valid || !pendingInstall) return;

	const { distroName, btn, card } = pendingInstall;
	closeUserSetupModal();
	await installWithTerminal(distroName, btn, card, username, password);
}

// ── Distro Settings ─────────────────────────────────────────────────

let cachedLoginOptions = null;
let currentSettingsDistro = null;

/**
 * Fetch login options from JOSINIFY=true chroot-distro login --help
 * @returns {Promise<Array>}
 */
async function fetchLoginOptions() {
	if (cachedLoginOptions) return cachedLoginOptions;
	try {
		const { errno, stdout } = await exec("JOSINIFY=true chroot-distro login --help");
		if (errno === 0 && stdout) {
			const data = JSON.parse(stdout.trim());
			cachedLoginOptions = data.options || [];
			return cachedLoginOptions;
		}
	} catch (e) {
		console.error("Failed to fetch login options:", e);
	}
	// Fallback
	return [];
}

/**
 * Fetch users list from a distro by parsing /etc/passwd
 * @param {string} distroName
 * @returns {Promise<Array<{name:string, uid:number}>>}
 */
async function fetchDistroUsers(distroName) {
	try {
		const passwdPath = `/data/local/chroot-distro/installed-rootfs/${distroName}/etc/passwd`;
		const { errno, stdout } = await exec(`cat "${passwdPath}" 2>/dev/null`);
		if (errno === 0 && stdout) {
			const users = [];
			const lines = stdout.trim().split("\n");
			for (const line of lines) {
				const parts = line.split(":");
				if (parts.length < 7) continue;
				const name = parts[0];
				const uid = parseInt(parts[2], 10);
				const shell = parts[6];
				// Include root and regular users with valid shells
				if ((uid === 0 || uid >= 1000) && !shell.includes("nologin") && !shell.includes("/bin/false") && !name.startsWith("nobody") && !name.startsWith("aid_")) {
					users.push({ name, uid });
				}
			}
			return users;
		}
	} catch (e) {
		console.error("Failed to fetch users:", e);
	}
	return [{ name: "root", uid: 0 }];
}

/**
 * Load per-distro settings from config file
 * @param {string} distroName
 * @returns {Promise<Object>}
 */
async function loadDistroSettings(distroName) {
	const defaults = {
		USER: "",
		ISOLATED: "false",
		SHARED_TMP: "false",
		TERMUX_HOME: "false",
		WORK_DIR: "",
		BIND: "",
		ENV: "",
	};
	try {
		const filePath = `${DISTRO_SETTINGS_DIR}/${distroName}.conf`;
		const { errno, stdout } = await exec(`cat "${filePath}" 2>/dev/null`);
		if (errno === 0 && stdout) {
			const settings = { ...defaults };
			for (const line of stdout.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || !trimmed.includes("=")) continue;
				const eqIdx = trimmed.indexOf("=");
				const key = trimmed.substring(0, eqIdx);
				const value = trimmed.substring(eqIdx + 1);
				if (key in settings) settings[key] = value;
			}
			return settings;
		}
	} catch (e) {
		console.warn("Failed to load distro settings:", e);
	}
	return defaults;
}

/**
 * Save per-distro settings to config file
 * @param {string} distroName
 * @param {Object} settings
 */
async function saveDistroSettings(distroName, settings) {
	const filePath = `${DISTRO_SETTINGS_DIR}/${distroName}.conf`;
	const lines = Object.entries(settings)
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");
	try {
		await exec(`mkdir -p "${DISTRO_SETTINGS_DIR}" && printf '%s\\n' '${shellEscape(lines)}' > "${filePath}"`);
	} catch (e) {
		console.error("Failed to save distro settings:", e);
		showToast("Failed to save settings", true);
	}
}

/**
 * Build the full login command for a distro based on saved settings
 * @param {string} distroName
 * @returns {Promise<string>}
 */
async function buildLoginCommand(distroName) {
	const s = await loadDistroSettings(distroName);
	let cmd = `chroot-distro login`;
	if (s.USER && s.USER !== "root" && s.USER !== "") cmd += ` --user ${s.USER}`;
	if (s.ISOLATED === "true") cmd += " --isolated";
	if (s.SHARED_TMP === "true") cmd += " --shared-tmp";
	if (s.TERMUX_HOME === "true") cmd += " --termux-home";
	if (s.WORK_DIR) cmd += ` --work-dir ${s.WORK_DIR}`;
	if (s.BIND) {
		for (const b of s.BIND.split(",").filter(Boolean)) {
			cmd += ` --bind ${b}`;
		}
	}
	if (s.ENV) {
		for (const e of s.ENV.split(",").filter(Boolean)) {
			cmd += ` --env ${e}`;
		}
	}
	cmd += ` ${distroName}`;
	return cmd;
}

/**
 * Update the command dropdown text and copy button for a distro
 * @param {string} distroName
 */
async function updateCommandDisplay(distroName) {
	const command = await buildLoginCommand(distroName);
	const textEl = document.getElementById(`command-text-${distroName}`);
	if (textEl) textEl.textContent = command;
	const card = document.getElementById(`card-${distroName}`);
	if (card) {
		const copyBtn = card.querySelector(".copy-btn");
		if (copyBtn) copyBtn.dataset.command = command;
	}
}

/**
 * Show distro settings modal
 * @param {string} distroName
 */
async function showDistroSettingsModal(distroName) {
	currentSettingsDistro = distroName;

	const modal = document.getElementById("distro-settings-modal");
	const title = document.getElementById("distro-settings-title");
	const loading = document.getElementById("distro-settings-loading");
	const form = document.getElementById("distro-settings-form");
	const fields = document.getElementById("distro-settings-fields");

	title.textContent = `${distroName} Settings`;
	loading.style.display = "";
	form.style.display = "none";
	modal.classList.add("open");

	// Reset to Login Settings tab
	switchDistroSettingsTab("login-settings");

	await new Promise((r) => setTimeout(r, 50));

	const [options, users, settings] = await Promise.all([fetchLoginOptions(), fetchDistroUsers(distroName), loadDistroSettings(distroName)]);

	const optionMap = {};
	for (const opt of options) {
		const flag = opt.name.split(" ")[0];
		optionMap[flag] = opt.description;
	}

	fields.innerHTML = "";

	const userLabel = optionMap["--user"] || "Login as specified user";
	fields.innerHTML += `
		<div class="form-group">
			<label class="form-label">${userLabel}</label>
			<select class="form-select" id="ds-user">
				${users.map((u) => `<option value="${u.name}" ${settings.USER === u.name ? "selected" : ""}>${u.name} (uid: ${u.uid})</option>`).join("")}
			</select>
		</div>
	`;

	const toggles = [
		{ flag: "--isolated", key: "ISOLATED" },
		{ flag: "--shared-tmp", key: "SHARED_TMP" },
		{ flag: "--termux-home", key: "TERMUX_HOME" },
	];

	for (const t of toggles) {
		const desc = optionMap[t.flag] || t.flag;
		const checked = settings[t.key] === "true" ? "checked" : "";
		fields.innerHTML += `
			<div class="setting-row">
				<div>
					<div class="setting-label">${desc}</div>
				</div>
				<label class="toggle-switch">
					<input type="checkbox" id="ds-${t.key}" ${checked} />
					<span class="toggle-slider"></span>
				</label>
			</div>
		`;
	}

	const textInputs = [
		{ flag: "--work-dir", key: "WORK_DIR", placeholder: "/path/to/dir" },
		{ flag: "--bind", key: "BIND", placeholder: "/src:/dst, /src2:/dst2" },
		{ flag: "--env", key: "ENV", placeholder: "VAR1=val1, VAR2=val2" },
	];

	for (const ti of textInputs) {
		const desc = optionMap[ti.flag] || ti.flag;
		fields.innerHTML += `
			<div class="form-group">
				<label class="form-label">${desc}</label>
				<input type="text" class="form-input" id="ds-${ti.key}" placeholder="${ti.placeholder}" value="${settings[ti.key] || ""}" />
			</div>
		`;
	}

	loading.style.display = "none";
	form.style.display = "";
}

/**
 * Close distro settings modal and save settings
 */
async function closeDistroSettingsModal() {
	if (currentSettingsDistro) {
		const distroName = currentSettingsDistro;
		const settings = {
			USER: document.getElementById("ds-user")?.value || "",
			ISOLATED: document.getElementById("ds-ISOLATED")?.checked ? "true" : "false",
			SHARED_TMP: document.getElementById("ds-SHARED_TMP")?.checked ? "true" : "false",
			TERMUX_HOME: document.getElementById("ds-TERMUX_HOME")?.checked ? "true" : "false",
			WORK_DIR: document.getElementById("ds-WORK_DIR")?.value?.trim() || "",
			BIND: document.getElementById("ds-BIND")?.value?.trim() || "",
			ENV: document.getElementById("ds-ENV")?.value?.trim() || "",
		};

		await saveDistroSettings(distroName, settings);
		await updateCommandDisplay(distroName);
		showToast(`Settings saved for ${distroName}`);
	}

	const modal = document.getElementById("distro-settings-modal");
	modal.classList.remove("open");
	currentSettingsDistro = null;
}

// ── Distro Settings Tabs ────────────────────────────────────────────────

/**
 * Switch between tabs in the distro settings modal
 * @param {string} tabId - 'login-settings' or 'user-management'
 */
function switchDistroSettingsTab(tabId) {
	// Update tab buttons
	document.querySelectorAll(".ds-tab-btn").forEach((btn) => {
		btn.classList.toggle("active", btn.dataset.tab === tabId);
	});

	// Update tab content
	const loginTab = document.getElementById("tab-login-settings");
	const userTab = document.getElementById("tab-user-management");

	if (tabId === "login-settings") {
		loginTab.style.display = "";
		loginTab.classList.add("active");
		userTab.style.display = "none";
		userTab.classList.remove("active");
	} else {
		loginTab.style.display = "none";
		loginTab.classList.remove("active");
		userTab.style.display = "";
		userTab.classList.add("active");
		if (currentSettingsDistro) {
			loadUserManagementTab(currentSettingsDistro);
		}
	}
}

// ── User Management ─────────────────────────────────────────────────────

let umSelectedGroups = new Set();

/**
 * Fetch ALL users from a distro's /etc/passwd
 * @param {string} distroName
 * @returns {Promise<Array<{name:string, uid:number, gid:number, home:string, shell:string}>>}
 */
async function fetchAllDistroUsers(distroName) {
	try {
		const passwdPath = `/data/local/chroot-distro/installed-rootfs/${distroName}/etc/passwd`;
		const { errno, stdout } = await exec(`cat "${passwdPath}" 2>/dev/null`);
		if (errno === 0 && stdout) {
			const users = [];
			for (const line of stdout.trim().split("\n")) {
				const parts = line.split(":");
				if (parts.length < 7) continue;
				const name = parts[0];
				const uid = parseInt(parts[2], 10);
				const gid = parseInt(parts[3], 10);
				const home = parts[5];
				const shell = parts[6];
				// Skip nologin and false-shell users, but keep root and real users
				if (shell.includes("nologin") || shell.includes("/bin/false")) continue;
				if (name.startsWith("nobody")) continue;
				users.push({ name, uid, gid, home, shell });
			}
			return users;
		}
	} catch (e) {
		console.error("Failed to fetch all users:", e);
	}
	return [{ name: "root", uid: 0, gid: 0, home: "/root", shell: "/bin/bash" }];
}

/**
 * Fetch all groups from a distro's /etc/group
 * @param {string} distroName
 * @returns {Promise<Array<string>>}
 */
async function fetchDistroGroups(distroName) {
	try {
		const groupPath = `/data/local/chroot-distro/installed-rootfs/${distroName}/etc/group`;
		const { errno, stdout } = await exec(`cat "${groupPath}" 2>/dev/null`);
		if (errno === 0 && stdout) {
			const groups = [];
			for (const line of stdout.trim().split("\n")) {
				const parts = line.split(":");
				if (parts.length >= 1 && parts[0]) {
					groups.push(parts[0]);
				}
			}
			return groups.sort();
		}
	} catch (e) {
		console.error("Failed to fetch groups:", e);
	}
	return [];
}

/**
 * Render the user list in the User Management tab
 * @param {string} distroName
 * @param {Array} users
 */
function renderUserList(distroName, users) {
	const container = document.getElementById("um-user-list");
	if (!container) return;

	if (users.length === 0) {
		container.innerHTML = '<div class="um-no-users">No users found</div>';
		return;
	}

	container.innerHTML = users
		.map((u) => {
			const isRoot = u.uid === 0;
			const isSystem = u.uid > 0 && u.uid < 1000;
			const badge = isRoot ? '<span class="user-badge root">root</span>' : isSystem ? '<span class="user-badge system">system</span>' : "";
			const canDelete = !isRoot && u.uid >= 1000;

			return `
			<div class="user-item" data-username="${u.name}">
				<div class="user-item-info">
					<div class="user-item-name">${u.name}${badge}</div>
					<div class="user-item-meta">
						<span>UID: ${u.uid}</span>
						<span>GID: ${u.gid}</span>
						<span>${u.shell}</span>
						<span>${u.home}</span>
					</div>
				</div>
				${
					canDelete
						? `<button class="user-delete-btn" data-username="${u.name}" title="Delete user">
					<svg viewBox="0 0 24 24" width="18" height="18"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>
				</button>`
						: ""
				}
			</div>`;
		})
		.join("");

	// Attach delete handlers
	container.querySelectorAll(".user-delete-btn").forEach((btn) => {
		btn.addEventListener("click", async (e) => {
			e.stopPropagation();
			const username = btn.dataset.username;
			await deleteUserFromDistro(distroName, username);
		});
	});
}

/**
 * Render group picker chips
 * @param {Array<string>} allGroups
 * @param {Set<string>} selected
 */
function renderGroupPicker(allGroups, selected) {
	const availableContainer = document.getElementById("um-groups-available");
	const addedContainer = document.getElementById("um-groups-added");
	if (!availableContainer || !addedContainer) return;

	const available = allGroups.filter((g) => !selected.has(g));
	const added = allGroups.filter((g) => selected.has(g));

	availableContainer.innerHTML = available.length ? available.map((g) => `<button type="button" class="group-chip available" data-group="${g}">${g}</button>`).join("") : '<span style="color: var(--text-muted); font-size: 12px; padding: 4px;">No groups available</span>';

	addedContainer.innerHTML = added.length ? added.map((g) => `<button type="button" class="group-chip added" data-group="${g}">${g}</button>`).join("") : '<span style="color: var(--text-muted); font-size: 12px; padding: 4px;">Click groups to add</span>';

	// Attach click listeners
	availableContainer.querySelectorAll(".group-chip").forEach((chip) => {
		chip.addEventListener("click", () => {
			umSelectedGroups.add(chip.dataset.group);
			renderGroupPicker(allGroups, umSelectedGroups);
		});
	});

	addedContainer.querySelectorAll(".group-chip").forEach((chip) => {
		chip.addEventListener("click", () => {
			umSelectedGroups.delete(chip.dataset.group);
			renderGroupPicker(allGroups, umSelectedGroups);
		});
	});
}

let umAllGroups = [];

/**
 * Load user management tab data
 * @param {string} distroName
 */
async function loadUserManagementTab(distroName) {
	const userList = document.getElementById("um-user-list");
	if (userList) {
		userList.innerHTML = '<div class="loading-container" style="padding: 20px;"><div class="spinner"></div><span>Loading users...</span></div>';
	}

	const [users, groups] = await Promise.all([fetchAllDistroUsers(distroName), fetchDistroGroups(distroName)]);

	renderUserList(distroName, users);

	// Ensure default groups are always visible in the list, even if not in /etc/group yet
	const defaultGroups = ["wheel", "polkitd", "audio", "video", "storage", "aid_inet", "aid_net_raw"];
	const mergedGroups = [...new Set([...groups, ...defaultGroups])].sort();
	umAllGroups = mergedGroups;

	// Pre-select default groups in the Added section
	umSelectedGroups = new Set(defaultGroups);
	renderGroupPicker(mergedGroups, umSelectedGroups);

	// Reset form
	resetAddUserForm();
}

/**
 * Reset add user form to initial state
 */
function resetAddUserForm() {
	const form = document.getElementById("um-create-user-form");
	if (form) form.reset();

	const addForm = document.getElementById("um-add-user-form");
	if (addForm) addForm.classList.add("hidden");

	const toggle = document.getElementById("um-add-user-toggle");
	if (toggle) toggle.style.display = "";

	// Clear errors
	["um-username-error", "um-password-error", "um-confirm-password-error"].forEach((id) => {
		const el = document.getElementById(id);
		if (el) el.textContent = "";
	});

	// Reset advanced fields
	const advFields = document.getElementById("um-advanced-fields");
	if (advFields) advFields.classList.add("hidden");
	const advToggle = document.getElementById("um-advanced-toggle");
	if (advToggle) advToggle.classList.remove("open");
}

/**
 * Add a new user to the distro
 * @param {string} distroName
 * @param {Event} e form submit event
 */
async function handleCreateUser(distroName, e) {
	e.preventDefault();

	const username = document.getElementById("um-username")?.value?.trim();
	const password = document.getElementById("um-password")?.value;
	const confirmPassword = document.getElementById("um-confirm-password")?.value;
	const uid = document.getElementById("um-uid")?.value?.trim();
	const gid = document.getElementById("um-gid")?.value?.trim();
	const shell = document.getElementById("um-shell")?.value?.trim();
	const home = document.getElementById("um-home")?.value?.trim();

	const usernameError = document.getElementById("um-username-error");
	const passwordError = document.getElementById("um-password-error");
	const confirmError = document.getElementById("um-confirm-password-error");

	// Reset errors
	if (usernameError) usernameError.textContent = "";
	if (passwordError) passwordError.textContent = "";
	if (confirmError) confirmError.textContent = "";

	let valid = true;

	if (!username) {
		if (usernameError) usernameError.textContent = "Username is required";
		valid = false;
	} else if (/\s/.test(username)) {
		if (usernameError) usernameError.textContent = "Username must not contain spaces";
		valid = false;
	} else if (/[^a-z0-9_-]/.test(username)) {
		if (usernameError) usernameError.textContent = "Username can only contain lowercase letters, digits, - and _";
		valid = false;
	}

	if (!password) {
		if (passwordError) passwordError.textContent = "Password is required";
		valid = false;
	}

	if (password !== confirmPassword) {
		if (confirmError) confirmError.textContent = "Passwords do not match";
		valid = false;
	}

	if (!valid) return;

	// Show spinner overlay on the form
	const addFormContainer = document.getElementById("um-add-user-form");
	const createBtn = document.getElementById("um-create-btn");
	const cancelBtn = document.getElementById("um-cancel-btn");

	// Create and show spinner overlay
	const spinnerOverlay = document.createElement("div");
	spinnerOverlay.className = "um-spinner-overlay";
	spinnerOverlay.innerHTML = '<div class="spinner"></div><span>Creating user...</span>';
	if (addFormContainer) addFormContainer.style.position = "relative";
	if (addFormContainer) addFormContainer.appendChild(spinnerOverlay);
	if (createBtn) createBtn.disabled = true;
	if (cancelBtn) cancelBtn.disabled = true;

	try {
		const escapedUser = shellEscape(username);
		const escapedPass = shellEscape(password);

		// Build useradd args
		let useraddArgs = "-m";
		if (uid) useraddArgs += ` -u ${shellEscape(uid)}`;
		if (gid) useraddArgs += ` -g ${shellEscape(gid)}`;
		else useraddArgs += " -g users";

		const groupList = Array.from(umSelectedGroups).join(",");
		if (groupList) useraddArgs += ` -G ${shellEscape(groupList)}`;

		if (shell) useraddArgs += ` -s ${shellEscape(shell)}`;
		else useraddArgs += ' -s "$(which bash 2>/dev/null || echo /bin/sh)"';

		if (home) useraddArgs += ` -d ${shellEscape(home)}`;

		// Build the commands to run inside the distro
		const innerCmds = [
			// Ensure all selected groups exist before creating the user
			...Array.from(umSelectedGroups).map((g) => `groupadd -f '${shellEscape(g)}' 2>/dev/null || true`),
			// Create the user
			`useradd ${useraddArgs} '${escapedUser}'`,
			// Copy skeleton files
			`cp -a /etc/skel/. /home/'${escapedUser}'/ 2>/dev/null || true`,
			`chown -R '${escapedUser}' /home/'${escapedUser}'/ 2>/dev/null || true`,
			// Set password
			`echo '${escapedUser}:${escapedPass}' | chpasswd`,
			// Add to supplementary groups via usermod
			groupList ? `usermod -aG ${shellEscape(groupList)} '${escapedUser}'` : "",
			// Setup sudoers
			"mkdir -p /etc/sudoers.d",
			`echo '${escapedUser} ALL=(ALL:ALL) ALL' > /etc/sudoers.d/'${escapedUser}'`,
			`chmod 0440 /etc/sudoers.d/'${escapedUser}'`,
		]
			.filter(Boolean)
			.join(" && ");

		// Use chroot-distro login to run the commands
		const fullCmd = `chroot-distro login ${shellEscape(distroName)} -- /bin/sh -c '${shellEscape(innerCmds)}'`;

		// Write to a temp script and spawn it (non-blocking, doesn't freeze UI). We use base64 to avoid quoting conflicts.
		const scriptPath = `${LOG_DIR}/um_adduser_${Date.now()}.sh`;
		const scriptContent = `#!/bin/sh\n${fullCmd}\n`;
		const b64 = btoa(scriptContent);
		await exec(`mkdir -p "${LOG_DIR}" && echo "${b64}" | base64 -d > "${scriptPath}" && chmod +x "${scriptPath}"`);

		const process = spawn("sh", [scriptPath]);

		process.on("exit", async (exitCode) => {
			// Clean up script
			exec(`rm -f "${scriptPath}"`);

			// Remove spinner overlay
			if (spinnerOverlay && spinnerOverlay.parentNode) spinnerOverlay.remove();
			if (createBtn) {
				createBtn.disabled = false;
				createBtn.textContent = "Create User";
			}
			if (cancelBtn) cancelBtn.disabled = false;

			if (exitCode === 0) {
				showToast(`User '${username}' created successfully`);
				// Refresh user list if still on the user management tab
				if (currentSettingsDistro === distroName) {
					await loadUserManagementTab(distroName);
				}
				cachedLoginOptions = null;
			} else {
				showToast(`Failed to create user (exit code: ${exitCode})`, true);
				console.error("User creation failed with exit code:", exitCode);
			}
		});

		process.on("error", (err) => {
			exec(`rm -f "${scriptPath}"`);
			if (spinnerOverlay && spinnerOverlay.parentNode) spinnerOverlay.remove();
			if (createBtn) {
				createBtn.disabled = false;
				createBtn.textContent = "Create User";
			}
			if (cancelBtn) cancelBtn.disabled = false;
			showToast(`Error creating user: ${err.message}`, true);
			console.error("User creation error:", err);
		});
	} catch (e) {
		// Remove spinner overlay on unexpected errors
		if (spinnerOverlay && spinnerOverlay.parentNode) spinnerOverlay.remove();
		if (createBtn) {
			createBtn.disabled = false;
			createBtn.textContent = "Create User";
		}
		if (cancelBtn) cancelBtn.disabled = false;
		showToast(`Error creating user: ${e.message}`, true);
		console.error("User creation error:", e);
	}
}

/**
 * Delete a user from the distro
 * @param {string} distroName
 * @param {string} username
 */
async function deleteUserFromDistro(distroName, username) {
	// Disable the delete button and add shake animation
	const btn = document.querySelector(`.user-delete-btn[data-username="${username}"]`);
	if (btn) {
		btn.disabled = true;
		btn.classList.add("shake-anim");
	}

	try {
		const escapedUser = shellEscape(username);

		const innerCmds = [`userdel -r '${escapedUser}' 2>/dev/null || userdel '${escapedUser}'`, `rm -f /etc/sudoers.d/'${escapedUser}'`].join(" && ");

		const fullCmd = `chroot-distro login ${shellEscape(distroName)} -- /bin/sh -c '${shellEscape(innerCmds)}'`;

		// Write to a temp script and spawn it (non-blocking). We use base64 to avoid quoting conflicts
		const scriptPath = `${LOG_DIR}/um_deluser_${Date.now()}.sh`;
		const scriptContent = `#!/bin/sh\n${fullCmd}\n`;
		const b64 = btoa(scriptContent);
		await exec(`mkdir -p "${LOG_DIR}" && echo "${b64}" | base64 -d > "${scriptPath}" && chmod +x "${scriptPath}"`);

		const process = spawn("sh", [scriptPath]);

		process.on("exit", async (exitCode) => {
			exec(`rm -f "${scriptPath}"`);

			if (exitCode === 0) {
				showToast(`User '${username}' deleted`);
				if (currentSettingsDistro === distroName) {
					await loadUserManagementTab(distroName);
				}
				cachedLoginOptions = null;
			} else {
				showToast(`Failed to delete user (exit code: ${exitCode})`, true);
				console.error("User deletion failed with exit code:", exitCode);
				if (btn) {
					btn.disabled = false;
					btn.classList.remove("shake-anim");
				}
			}
		});

		process.on("error", (err) => {
			exec(`rm -f "${scriptPath}"`);
			showToast(`Error deleting user: ${err.message}`, true);
			console.error("User deletion error:", err);
			if (btn) {
				btn.disabled = false;
				btn.classList.remove("shake-anim");
			}
		});
	} catch (e) {
		showToast(`Error deleting user: ${e.message}`, true);
		console.error("User deletion error:", e);
		if (btn) {
			btn.disabled = false;
			btn.classList.remove("shake-anim");
		}
	}
}

/**
 * Handle action based on action type
 * @param {string} distroName
 * @param {string} action - 'start', 'install', 'uninstall', or 'settings'
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} card
 */
async function handleAction(distroName, action, btn, card) {
	switch (action) {
		case "start": {
			const command = await buildLoginCommand(distroName);
			await copyToClipboard(command);

			const commandDropdown = card.querySelector(`#command-${distroName}`);
			if (commandDropdown) {
				commandDropdown.classList.add("open");
			}
			break;
		}

		case "settings":
			await showDistroSettingsModal(distroName);
			break;

		case "install":
			if (localStorage.getItem("skipUserCreation") === "true") {
				await installWithTerminal(distroName, btn, card, null, null, true);
			} else {
				showUserSetupModal(distroName, btn, card);
			}
			break;

		case "stop":
			await stopWithTerminal(distroName, btn, card);
			break;

		case "uninstall":
			await uninstallWithTerminal(distroName, btn, card);
			break;
	}
}

/**
 * Stop/Unmount distribution with terminal output
 * @param {string} distroName
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} card
 */
async function stopWithTerminal(distroName, btn, card) {
	const terminal = card.querySelector(`#terminal-${distroName}`);
	const terminalOutput = terminal.querySelector(".terminal-output");
	const terminalTitle = terminal.querySelector(".terminal-title span");

	const closeBtn = terminal.querySelector(".terminal-close-btn");

	btn.disabled = true;
	const startBtn = card.querySelector('[data-action="start"]');
	if (startBtn) startBtn.disabled = true;
	const uninstallBtn = card.querySelector('[data-action="uninstall"]');
	if (uninstallBtn) uninstallBtn.disabled = true;

	closeBtn.disabled = true;
	terminalOutput.innerHTML = "";

	terminalTitle.textContent = `Stopping ${distroName}...`;
	terminalTitle.style.color = "";

	terminal.classList.add("open");
	setTimeout(() => {
		terminal.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}, 100);

	appendTerminalLine(terminalOutput, `$ chroot-distro unmount ${distroName}`);
	appendTerminalLine(terminalOutput, "");

	try {
		const logPath = getLogPath(distroName, "stop");
		await exec(`mkdir -p "${LOG_DIR}" && echo "Starting stop..." > "${logPath}"`);

		const scriptPath = `${LOG_DIR}/${distroName}_stop.sh`;
		await exec(`echo 'chroot-distro unmount ${distroName} >> "${logPath}" 2>&1' > "${scriptPath}" && chmod +x "${scriptPath}"`);
		const process = spawn("sh", [scriptPath]);

		startLogWatcher(distroName, logPath, terminalOutput);

		const exitCode = await new Promise((resolve) => {
			process.on("exit", (code) => resolve(code));
			process.on("error", () => resolve(1));
		});

		if (activeWatchers.has(distroName)) {
			clearInterval(activeWatchers.get(distroName));
			activeWatchers.delete(distroName);
			const { stdout } = await exec(`cat "${logPath}"`);
			if (stdout) appendTerminalLine(terminalOutput, stdout);
		}

		activeTerminals.delete(distroName);

		const { errno, stdout } = await exec("JOSINIFY=true chroot-distro list-running");
		let stopSuccess = false;

		if (errno === 0 && stdout) {
			try {
				const data = JSON.parse(stdout.trim());
				const runningDistros = data.running_distributions || [];
				stopSuccess = !runningDistros.some((d) => d.name === distroName);
			} catch (e) {
				console.warn("Failed to parse running list:", e);
				stopSuccess = exitCode === 0;
			}
		} else {
			stopSuccess = exitCode === 0;
		}

		if (stopSuccess) {
			terminalTitle.textContent = `${distroName} stopped successfully!`;
			terminalTitle.style.color = "#4ade80";
			appendTerminalLine(terminalOutput, "", "success");
			appendTerminalLine(terminalOutput, "✓ Unmount completed successfully!", "success");

			showToast(`${distroName} stopped successfully!`);

			setTimeout(async () => {
				terminal.classList.remove("open");
				await refreshDistroCard(distroName, card);
			}, 2000);
		} else {
			terminalTitle.textContent = `Stop failed (exit code: ${exitCode})`;
			terminalTitle.style.color = "#e94560";
			appendTerminalLine(terminalOutput, "", "error");
			appendTerminalLine(terminalOutput, `✗ Unmount failed with exit code ${exitCode}`, "error");

			showToast("Stop failed", true);
			closeBtn.disabled = false;
			btn.disabled = false;
			if (startBtn) startBtn.disabled = false;
			if (uninstallBtn) uninstallBtn.disabled = false;
		}
	} catch (e) {
		console.error("Stop error:", e);

		terminalTitle.textContent = "Stop error";
		terminalTitle.style.color = "#e94560";
		appendTerminalLine(terminalOutput, `Error: ${e.message}`, "error");

		showToast(e.message, true);
		closeBtn.disabled = false;
		btn.disabled = false;
		if (startBtn) startBtn.disabled = false;
		if (uninstallBtn) uninstallBtn.disabled = false;
	}
}

/**
 * Install distribution with terminal output
 * @param {string} distroName
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} card
 * @param {string} [username] - optional username for --adduser
 * @param {string} [password] - optional password for --adduser
 * @param {boolean} [skipUserAdd] - if true, prepend SKIP_USERADD=1
 */
async function installWithTerminal(distroName, btn, card, username, password, skipUserAdd) {
	const terminal = card.querySelector(`#terminal-${distroName}`);
	const terminalOutput = terminal.querySelector(".terminal-output");
	const terminalTitle = terminal.querySelector(".terminal-title span");

	const closeBtn = terminal.querySelector(".terminal-close-btn");

	btn.disabled = true;

	const btnIcon = btn.querySelector("svg");
	if (btnIcon) btnIcon.classList.add("download-anim");

	closeBtn.disabled = true;
	terminalOutput.innerHTML = "";

	terminalTitle.textContent = `Installing ${distroName}...`;
	terminalTitle.style.color = "";

	terminal.classList.add("open");
	setTimeout(() => {
		terminal.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}, 100);

	// Build install command with optional --adduser or SKIP_USERADD
	let installCmd;
	let displayCmd;
	if (skipUserAdd) {
		installCmd = `SKIP_USERADD=1 chroot-distro install ${distroName}`;
		displayCmd = installCmd;
	} else {
		installCmd = `chroot-distro install ${distroName}`;
		displayCmd = installCmd;
		if (username && password) {
			installCmd += ` --adduser '${shellEscape(username)}' '${shellEscape(password)}'`;
			displayCmd += ` --adduser ${username} ********`;
		}
	}

	appendTerminalLine(terminalOutput, `$ ${displayCmd}`);
	appendTerminalLine(terminalOutput, "");

	try {
		const logPath = getLogPath(distroName, "install");
		await exec(`mkdir -p "${LOG_DIR}"`);

		saveActiveTask(distroName, "install");

		const scriptPath = `${LOG_DIR}/${distroName}_install.sh`;
		await exec(`echo '${installCmd} > "${logPath}" 2>&1' > "${scriptPath}" && chmod +x "${scriptPath}"`);

		const process = spawn("sh", [scriptPath]);

		startLogWatcher(distroName, logPath, terminalOutput, async () => {
			await handleTaskCompletion(distroName, "install", card, terminal, terminalTitle, terminalOutput, btn, closeBtn);
			if (btnIcon) btnIcon.classList.remove("download-anim");
		});

		const exitCode = await new Promise((resolve) => {
			process.on("exit", (code) => {
				resolve(code);
			});
			process.on("error", (err) => {
				appendTerminalLine(terminalOutput, `Error: ${err.message}`, "error");
				resolve(1);
			});
		});

		if (activeWatchers.has(distroName)) {
			clearInterval(activeWatchers.get(distroName));
			activeWatchers.delete(distroName);
			const { stdout } = await exec(`cat "${logPath}"`);
			if (stdout) appendTerminalLine(terminalOutput, stdout);
		}
		await handleTaskCompletion(distroName, "install", card, terminal, terminalTitle, terminalOutput, btn, closeBtn);
		if (btnIcon) btnIcon.classList.remove("download-anim");
	} catch (e) {
		console.error("Install error:", e);
		if (btnIcon) btnIcon.classList.remove("download-anim");

		terminalTitle.textContent = "Installation error";
		terminalTitle.style.color = "#e94560";
		appendTerminalLine(terminalOutput, `Error: ${e.message}`, "error");

		showToast(e.message, true);
		closeBtn.disabled = false;
		btn.disabled = false;
		removeActiveTask(distroName);
	}
}

/**
 * Uninstall distribution with terminal output
 * @param {string} distroName
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} card
 */
async function uninstallWithTerminal(distroName, btn, card) {
	const terminal = card.querySelector(`#terminal-${distroName}`);
	const terminalOutput = terminal.querySelector(".terminal-output");
	const terminalTitle = terminal.querySelector(".terminal-title span");

	const closeBtn = terminal.querySelector(".terminal-close-btn");

	btn.disabled = true;

	const btnIcon = btn.querySelector("svg");
	if (btnIcon) btnIcon.classList.add("shake-anim");

	const startBtn = card.querySelector('[data-action="start"]');
	if (startBtn) startBtn.disabled = true;

	closeBtn.disabled = true;
	terminalOutput.innerHTML = "";

	terminalTitle.textContent = `Removing ${distroName}...`;
	terminalTitle.style.color = "";

	terminal.classList.add("open");
	setTimeout(() => {
		terminal.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}, 100);

	appendTerminalLine(terminalOutput, `$ chroot-distro remove ${distroName}`);
	appendTerminalLine(terminalOutput, "");

	try {
		const logPath = getLogPath(distroName, "uninstall");
		await exec(`mkdir -p "${LOG_DIR}"`);
		saveActiveTask(distroName, "uninstall");

		const scriptPath = `${LOG_DIR}/${distroName}_uninstall.sh`;
		await exec(`echo 'chroot-distro remove ${distroName} > "${logPath}" 2>&1' > "${scriptPath}" && chmod +x "${scriptPath}"`);

		const process = spawn("sh", [scriptPath]);

		startLogWatcher(distroName, logPath, terminalOutput, async () => {
			await handleTaskCompletion(distroName, "uninstall", card, terminal, terminalTitle, terminalOutput, btn, closeBtn);
			if (btnIcon) btnIcon.classList.remove("shake-anim");
		});

		const exitCode = await new Promise((resolve) => {
			process.on("exit", (code) => resolve(code));
			process.on("error", (err) => {
				appendTerminalLine(terminalOutput, `Error: ${err.message}`, "error");
				resolve(1);
			});
		});

		if (activeWatchers.has(distroName)) {
			clearInterval(activeWatchers.get(distroName));
			activeWatchers.delete(distroName);
			const { stdout } = await exec(`cat "${logPath}"`);
			if (stdout) appendTerminalLine(terminalOutput, stdout);
		}

		await handleTaskCompletion(distroName, "uninstall", card, terminal, terminalTitle, terminalOutput, btn, closeBtn);
		if (btnIcon) btnIcon.classList.remove("shake-anim");
	} catch (e) {
		console.error("Uninstall error:", e);
		if (btnIcon) btnIcon.classList.remove("shake-anim"); // Stop animation

		terminalTitle.textContent = "Removal error";
		terminalTitle.style.color = "#e94560";
		appendTerminalLine(terminalOutput, `Error: ${e.message}`, "error");

		showToast(e.message, true);
		closeBtn.disabled = false;
		btn.disabled = false;
		removeActiveTask(distroName);
		if (startBtn) startBtn.disabled = false;
	}
}

/**
 * Sorts the existing distro cards in the DOM based on currentSortOrder and allDistros
 */
function sortDistroCards() {
	const cards = Array.from(mainContent.querySelectorAll(".distro-card"));

	cards.sort((a, b) => {
		const nameA = a.id.replace("card-", "");
		const nameB = b.id.replace("card-", "");
		const distroA = allDistros.find((d) => d.name === nameA);
		const distroB = allDistros.find((d) => d.name === nameB);

		if (!distroA || !distroB) return 0;

		if (currentSortOrder === "za") {
			return distroB.name.localeCompare(distroA.name);
		} else if (currentSortOrder === "installed") {
			if (distroA.installed !== distroB.installed) return distroA.installed ? -1 : 1;
			return distroA.name.localeCompare(distroB.name);
		} else if (currentSortOrder === "running") {
			if (distroA.running !== distroB.running) return distroA.running ? -1 : 1;
			return distroA.name.localeCompare(distroB.name);
		} else {
			return distroA.name.localeCompare(distroB.name);
		}
	});

	cards.forEach((card) => mainContent.appendChild(card));
}

/**
 * Refresh distro card after install
 * @param {string} distroName
 * @param {HTMLElement} oldCard
 */
async function refreshDistroCard(distroName, oldCard) {
	try {
		const distros = await fetchDistros();
		allDistros = distros;
		const distroInfo = distros.find((d) => d.name === distroName);

		if (distroInfo) {
			const newCard = createDistroCard(distroInfo);
			oldCard.replaceWith(newCard);
			if (distroInfo.installed) {
				updateCommandDisplay(distroName);
			}
			sortDistroCards();
		}
	} catch (e) {
		console.error("Failed to refresh card:", e);
	}
}

/**
 * Render error state
 * @param {string} message
 */
function renderError(message) {
	mainContent.innerHTML = `
        <div class="error-container">
            <span>${message}</span>
            <button class="action-btn ripple-element" id="retry-btn">Retry</button>
        </div>
    `;

	const retryBtn = document.getElementById("retry-btn");
	applyRipple(retryBtn);
	retryBtn.addEventListener("click", loadDistros);
}

/**
 * Render distributions to the DOM
 * @param {Array} distros
 */
function renderDistros(distros) {
	mainContent.innerHTML = "";

	let sortedDistros = [...distros];
	sortedDistros.sort((a, b) => {
		if (currentSortOrder === "za") {
			return b.name.localeCompare(a.name);
		} else if (currentSortOrder === "installed") {
			if (a.installed !== b.installed) return a.installed ? -1 : 1;
			return a.name.localeCompare(b.name);
		} else if (currentSortOrder === "running") {
			if (a.running !== b.running) return a.running ? -1 : 1;
			return a.name.localeCompare(b.name);
		} else {
			return a.name.localeCompare(b.name);
		}
	});

	const title = document.createElement("div");
	title.className = "section-title";
	title.textContent = "Available Distributions";
	mainContent.appendChild(title);

	sortedDistros.forEach((distro) => {
		const card = createDistroCard(distro);
		mainContent.appendChild(card);
		if (distro.installed) {
			updateCommandDisplay(distro.name);
		}
	});

	if (sortedDistros.length === 0) {
		mainContent.innerHTML += `
            <div class="loading-container">
                <span>No distributions found</span>
            </div>
        `;
	}
}

/**
 * Filter distributions based on search query
 * @param {string} query
 */
function filterDistros(query) {
	const lowerQuery = query.toLowerCase();
	const filtered = allDistros.filter((d) => d.name.toLowerCase().includes(lowerQuery));
	renderDistros(filtered);
}

/**
 * Toggle search mode
 * @param {boolean} show
 */
function toggleSearch(show) {
	const refreshBtn = document.getElementById("refresh-btn");
	if (show) {
		titleContainer.classList.add("hidden");
		searchContainer.classList.remove("hidden");
		if (refreshBtn) refreshBtn.classList.add("hidden");
		searchInput.focus();
	} else {
		searchContainer.classList.add("hidden");
		titleContainer.classList.remove("hidden");
		if (refreshBtn) refreshBtn.classList.remove("hidden");
		searchInput.value = "";
		filterDistros(""); // Reset filter
	}
}

/**
 * Load and render distributions
 */
async function loadDistros() {
	mainContent.innerHTML = `
        <div class="loading-container" id="loading">
            <div class="spinner"></div>
            <span>Loading distributions...</span>
        </div>
    `;

	try {
		allDistros = await fetchDistros();
		if (!searchContainer.classList.contains("hidden") && searchInput.value) {
			filterDistros(searchInput.value);
		} else {
			renderDistros(allDistros);
		}
		await syncActiveTasksUI();
	} catch (e) {
		console.error("Failed to load distributions:", e);
		renderError("Failed to load distributions. Make sure chroot-distro is installed.");
	}
}

let cachedAndroidVersion = null;

async function getAndroidVersion() {
	if (cachedAndroidVersion !== null) return cachedAndroidVersion;
	try {
		const { errno, stdout } = await exec("getprop ro.build.version.sdk");
		if (errno === 0 && stdout) {
			const sdk = parseInt(stdout.trim(), 10);
			if (sdk >= 31) {
				if (sdk === 31) cachedAndroidVersion = 12;
				else if (sdk === 32) cachedAndroidVersion = 12.1;
				else if (sdk === 33) cachedAndroidVersion = 13;
				else if (sdk === 34) cachedAndroidVersion = 14;
				else cachedAndroidVersion = 15;
				return cachedAndroidVersion;
			}
		}
	} catch (e) {
		console.warn("Failed to get Android version:", e);
	}
	cachedAndroidVersion = 0;
	return 0;
}

async function checkPhantomProcessState() {
	const ver = await getAndroidVersion();
	if (ver < 12) return false;

	try {
		if (ver === 12) {
			const syncRes = await exec("/system/bin/device_config is_sync_disabled_for_tests");
			const syncDisabled = syncRes.errno === 0 && syncRes.stdout && syncRes.stdout.trim() === "true";

			const maxRes = await exec("/system/bin/device_config get activity_manager max_phantom_processes");
			const maxSet = maxRes.errno === 0 && maxRes.stdout && maxRes.stdout.trim() === "2147483647";

			return syncDisabled && maxSet;
		} else if (ver === 12.1 || ver === 13) {
			const settingsRes = await exec("settings get global settings_enable_monitor_phantom_procs");
			return settingsRes.errno === 0 && settingsRes.stdout && settingsRes.stdout.trim() === "false";
		} else if (ver >= 14) {
			const propRes = await exec("getprop persist.sys.fflag.override.settings_enable_monitor_phantom_procs");
			return propRes.errno === 0 && propRes.stdout && propRes.stdout.trim() === "false";
		} else {
			return false;
		}
	} catch (e) {
		console.warn("Failed to check phantom process state:", e);
		return false;
	}
}

async function setPhantomProcessKiller(disable) {
	const ver = await getAndroidVersion();
	if (ver < 12) return;

	const toggle = document.getElementById("toggle-phantom-process");
	const card = document.getElementById("setting-phantom-process");
	if (toggle) toggle.disabled = true;
	if (card) card.classList.add("disabled");

	try {
		if (ver === 12) {
			if (disable) {
				await exec("/system/bin/device_config set_sync_disabled_for_tests persistent");
				await exec("/system/bin/device_config put activity_manager max_phantom_processes 2147483647");
			} else {
				await exec("/system/bin/device_config set_sync_disabled_for_tests none");
				await exec("/system/bin/device_config delete activity_manager max_phantom_processes");
			}
		} else if (ver === 12.1 || ver === 13) {
			if (disable) {
				await exec("settings put global settings_enable_monitor_phantom_procs false");
			} else {
				await exec("settings delete global settings_enable_monitor_phantom_procs");
			}
		} else if (ver >= 14) {
			if (disable) {
				await exec("setprop persist.sys.fflag.override.settings_enable_monitor_phantom_procs false");
			} else {
				await exec("setprop persist.sys.fflag.override.settings_enable_monitor_phantom_procs ''");
			}
		} else {
			showToast("Unsupported Android version", true);
			return;
		}

		const actualState = await checkPhantomProcessState();
		if (toggle) toggle.checked = actualState;

		if (actualState === disable) {
			showToast(disable ? "Phantom process killer disabled" : "Phantom process killer enabled");
		} else {
			showToast("Failed to update phantom process killer state", true);
		}
	} catch (e) {
		console.error("Failed to set phantom process killer:", e);
		showToast("Failed to update phantom process killer", true);
		const actualState = await checkPhantomProcessState();
		if (toggle) toggle.checked = actualState;
	} finally {
		if (toggle) toggle.disabled = false;
		if (card) card.classList.remove("disabled");
	}
}

/**
 * Load settings from file and update UI
 */
async function loadSettings() {
	const toggleServiced = document.getElementById("toggle-serviced");
	const toggleServicedVerbose = document.getElementById("toggle-serviced-verbose");

	try {
		const { errno, stdout } = await exec(`cat "${SETTINGS_PATH}"`);
		let serviced = false;
		let verbose = false;

		if (errno === 0 && stdout) {
			const lines = stdout.split("\n");
			lines.forEach((line) => {
				const trimmed = line.trim();
				if (trimmed.startsWith("SERVICED=")) {
					serviced = trimmed.split("=")[1].trim() === "true";
				}
				if (trimmed.startsWith("SERVICED_VERBOSE_MODE=")) {
					verbose = trimmed.split("=")[1].trim() === "true";
				}
				if (trimmed.startsWith("SORT_ORDER=")) {
					currentSortOrder = trimmed.split("=")[1].trim();
				}
			});
		}

		if (toggleServiced) {
			toggleServiced.checked = serviced;
			updateVerboseToggleState(serviced);
		}
		if (toggleServicedVerbose) toggleServicedVerbose.checked = verbose;

		const selectSortOrder = document.getElementById("select-sort-order");
		if (selectSortOrder) selectSortOrder.value = currentSortOrder;
	} catch (e) {
		console.warn("Failed to load settings:", e);
		if (toggleServiced) toggleServiced.checked = false;
		if (toggleServicedVerbose) toggleServicedVerbose.checked = false;
	}

	const phantomSection = document.getElementById("phantom-process-section");
	const togglePhantom = document.getElementById("toggle-phantom-process");
	const phantomDesc = document.getElementById("phantom-process-desc");
	const ver = await getAndroidVersion();

	if (ver >= 12 && phantomSection) {
		phantomSection.classList.remove("hidden");
		if (ver === 12) {
			if (phantomDesc) phantomDesc.textContent = "Disable sync & set max phantom processes (Android 12)";
		} else if (ver < 14) {
			if (phantomDesc) phantomDesc.textContent = "Disable phantom process monitoring (Android " + (ver === 12.1 ? "12L" : "13") + ")";
		} else {
			if (phantomDesc) phantomDesc.textContent = "Disable phantom process monitoring (Android " + Math.floor(ver) + "+)";
		}
		if (togglePhantom) {
			togglePhantom.checked = await checkPhantomProcessState();
		}
	}
}

/**
 * Save a single setting to file
 * @param {string} key
 * @param {boolean|string} value
 */
async function saveSetting(key, value) {
	const valStr = typeof value === "boolean" ? (value ? "true" : "false") : value;
	const cmd = `
        mkdir -p "$(dirname "${SETTINGS_PATH}")"
        if [ ! -f "${SETTINGS_PATH}" ]; then touch "${SETTINGS_PATH}"; fi
        if grep -q "^${key}=" "${SETTINGS_PATH}"; then
            sed -i "s/^${key}=.*/${key}=${valStr}/" "${SETTINGS_PATH}"
        else
            echo "${key}=${valStr}" >> "${SETTINGS_PATH}"
        fi
    `.trim();

	try {
		await exec(cmd);
	} catch (e) {
		console.error("Failed to save setting:", e);
		showToast("Failed to save settings", true);
	}
}

/**
 * Initialize the app
 */
/**
 * Set up password eye toggle and real-time confirm mismatch feedback
 * @param {string} passwordId - ID of the password input
 * @param {string} confirmId - ID of the confirm password input
 */
function setupPasswordFeatures(passwordId, confirmId) {
	const passwordInput = document.getElementById(passwordId);
	const confirmInput = document.getElementById(confirmId);

	// Real-time confirm password mismatch feedback
	if (passwordInput && confirmInput) {
		const checkMatch = () => {
			const pw = passwordInput.value;
			const cpw = confirmInput.value;
			if (!cpw) {
				confirmInput.classList.remove("mismatch", "match");
			} else if (pw !== cpw) {
				confirmInput.classList.add("mismatch");
				confirmInput.classList.remove("match");
			} else {
				confirmInput.classList.add("match");
				confirmInput.classList.remove("mismatch");
			}
		};
		confirmInput.addEventListener("input", checkMatch);
		passwordInput.addEventListener("input", checkMatch);
	}
}

/**
 * Set up eye toggle buttons for showing/hiding passwords
 */
function setupEyeToggles() {
	document.querySelectorAll(".password-eye-btn").forEach((btn) => {
		btn.addEventListener("click", () => {
			const targetId = btn.dataset.target;
			const input = document.getElementById(targetId);
			if (!input) return;

			const eyeIcon = btn.querySelector(".eye-icon");
			const eyeOffIcon = btn.querySelector(".eye-off-icon");

			if (input.type === "password") {
				input.type = "text";
				if (eyeIcon) eyeIcon.classList.add("hidden");
				if (eyeOffIcon) eyeOffIcon.classList.remove("hidden");
				btn.title = "Hide password";
			} else {
				input.type = "password";
				if (eyeIcon) eyeIcon.classList.remove("hidden");
				if (eyeOffIcon) eyeOffIcon.classList.add("hidden");
				btn.title = "Show password";
			}
		});
	});
}

async function init() {
	document.querySelectorAll(".ripple-element").forEach(applyRipple);

	const refreshBtn = document.getElementById("refresh-btn");
	if (refreshBtn) {
		refreshBtn.addEventListener("click", () => {
			loadDistros();
		});
	}

	if (navHome && navSettings) {
		navHome.addEventListener("click", () => switchView("home"));
		navSettings.addEventListener("click", () => switchView("settings"));
	}

	if (helpBtn) helpBtn.addEventListener("click", showHelp);
	if (closeHelpModalBtn) closeHelpModalBtn.addEventListener("click", () => helpModal.classList.remove("open"));
	if (helpModal)
		helpModal.addEventListener("click", (e) => {
			if (e.target === helpModal) helpModal.classList.remove("open");
		});
	if (clearCacheBtn) clearCacheBtn.addEventListener("click", clearCache);

	// User setup modal events
	const userSetupModal = document.getElementById("user-setup-modal");
	const userSetupForm = document.getElementById("user-setup-form");
	const closeUserSetupBtn = document.getElementById("close-user-setup-modal");
	const userSetupCancelBtn = document.getElementById("user-setup-cancel");

	if (userSetupForm) userSetupForm.addEventListener("submit", validateAndInstall);
	if (closeUserSetupBtn) closeUserSetupBtn.addEventListener("click", closeUserSetupModal);
	if (userSetupCancelBtn) userSetupCancelBtn.addEventListener("click", closeUserSetupModal);
	if (userSetupModal)
		userSetupModal.addEventListener("click", (e) => {
			if (e.target === userSetupModal) closeUserSetupModal();
		});

	// Password eye toggles and real-time mismatch feedback
	setupEyeToggles();
	setupPasswordFeatures("setup-password", "setup-confirm-password");
	setupPasswordFeatures("um-password", "um-confirm-password");

	// Distro settings modal events
	const distroSettingsModal = document.getElementById("distro-settings-modal");
	const closeDistroSettingsBtn = document.getElementById("close-distro-settings-modal");

	if (closeDistroSettingsBtn) closeDistroSettingsBtn.addEventListener("click", closeDistroSettingsModal);
	if (distroSettingsModal)
		distroSettingsModal.addEventListener("click", (e) => {
			if (e.target === distroSettingsModal) closeDistroSettingsModal();
		});

	// Tab switching
	document.querySelectorAll(".ds-tab-btn").forEach((btn) => {
		btn.addEventListener("click", () => {
			switchDistroSettingsTab(btn.dataset.tab);
		});
	});

	// User management events
	const umAddUserToggle = document.getElementById("um-add-user-toggle");
	if (umAddUserToggle) {
		umAddUserToggle.addEventListener("click", () => {
			const addForm = document.getElementById("um-add-user-form");
			if (addForm) addForm.classList.remove("hidden");
			umAddUserToggle.style.display = "none";
			// Reset groups to defaults
			umSelectedGroups = new Set(["wheel", "polkitd", "audio", "video", "storage", "aid_inet", "aid_net_raw"]);
			renderGroupPicker(umAllGroups, umSelectedGroups);
		});
		applyRipple(umAddUserToggle);
	}

	const umCancelBtn = document.getElementById("um-cancel-btn");
	if (umCancelBtn) {
		umCancelBtn.addEventListener("click", () => {
			resetAddUserForm();
		});
		applyRipple(umCancelBtn);
	}

	const umCreateForm = document.getElementById("um-create-user-form");
	if (umCreateForm) {
		umCreateForm.addEventListener("submit", (e) => {
			if (currentSettingsDistro) {
				handleCreateUser(currentSettingsDistro, e);
			}
		});
	}

	const umAdvancedToggle = document.getElementById("um-advanced-toggle");
	if (umAdvancedToggle) {
		umAdvancedToggle.addEventListener("click", () => {
			const fields = document.getElementById("um-advanced-fields");
			if (fields) {
				const isHidden = fields.classList.toggle("hidden");
				umAdvancedToggle.classList.toggle("open", !isHidden);
			}
		});
	}

	if (searchBtn) {
		searchBtn.addEventListener("click", () => toggleSearch(true));
	}
	if (searchCloseBtn) {
		searchCloseBtn.addEventListener("click", () => toggleSearch(false));
	}
	if (searchInput) {
		searchInput.addEventListener("input", (e) => filterDistros(e.target.value));
		searchInput.addEventListener("keydown", (e) => {
			if (e.key === "Escape") toggleSearch(false);
		});
	}

	if (navSettings) {
		navSettings.addEventListener("click", () => toggleSearch(false));
	}

	const toggleServiced = document.getElementById("toggle-serviced");
	if (toggleServiced) {
		toggleServiced.addEventListener("change", (e) => {
			saveSetting("SERVICED", e.target.checked);
			updateVerboseToggleState(e.target.checked);
		});
	}

	const toggleServicedVerbose = document.getElementById("toggle-serviced-verbose");
	if (toggleServicedVerbose) {
		toggleServicedVerbose.addEventListener("change", (e) => {
			saveSetting("SERVICED_VERBOSE_MODE", e.target.checked);
		});
	}

	const toggleSkipUseradd = document.getElementById("toggle-skip-useradd");
	if (toggleSkipUseradd) {
		toggleSkipUseradd.checked = localStorage.getItem("skipUserCreation") === "true";
		toggleSkipUseradd.addEventListener("change", (e) => {
			localStorage.setItem("skipUserCreation", e.target.checked ? "true" : "false");
		});
	}

	const togglePhantom = document.getElementById("toggle-phantom-process");
	if (togglePhantom) {
		togglePhantom.addEventListener("change", (e) => {
			setPhantomProcessKiller(e.target.checked);
		});
	}

	const selectSortOrder = document.getElementById("select-sort-order");
	if (selectSortOrder) {
		selectSortOrder.addEventListener("change", (e) => {
			currentSortOrder = e.target.value;
			saveSetting("SORT_ORDER", currentSortOrder);
			if (!searchContainer.classList.contains("hidden") && searchInput.value) {
				filterDistros(searchInput.value);
			} else {
				sortDistroCards();
			}
		});
	}

	await fetchVersion();
	await loadSettings();
	await loadDistros();
}

function updateVerboseToggleState(enabled) {
	const card = document.getElementById("setting-serviced-verbose");
	const toggle = document.getElementById("toggle-serviced-verbose");
	if (card && toggle) {
		if (enabled) {
			card.classList.remove("disabled");
			toggle.disabled = false;
		} else {
			card.classList.add("disabled");
			toggle.disabled = true;
			toggle.checked = false;
		}
	}
}

document.addEventListener("DOMContentLoaded", init);
