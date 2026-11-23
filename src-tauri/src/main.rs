// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Native side: MIDI output only. The webview handles camera, hand tracking
//! and smoothing, and calls `midi_cc` whenever an output value changes.

use std::collections::HashMap;
use std::sync::Mutex;

use midir::{MidiOutput, MidiOutputConnection};
use serde::Serialize;
use tauri::{Manager, State};

const CLIENT_NAME: &str = "Webcam to MIDI";
/// Name of the port this app creates itself (macOS / Linux only).
const VIRTUAL_PORT_NAME: &str = "Webcam MIDI";

const SEL_ALL: &str = "__all__";
const SEL_VIRTUAL: &str = "__virtual__";

struct Midi {
    /// `__all__`, `__virtual__`, or the name of an existing output port.
    selection: String,
    /// Our own port. Created at startup where the OS allows it, kept open for
    /// the app's lifetime so DAWs can map to it once and keep the mapping.
    virtual_port: Option<MidiOutputConnection>,
    /// Open connections to existing ports, keyed by port name.
    connections: HashMap<String, MidiOutputConnection>,
    /// Ports we tried to open and couldn't (e.g. held exclusively on Windows).
    failed: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MidiInfo {
    ports: Vec<String>,
    virtual_port: Option<String>,
    selection: String,
    failed: Vec<String>,
}

fn port_names() -> Vec<String> {
    let Ok(out) = MidiOutput::new(CLIENT_NAME) else { return Vec::new() };
    let mut names: Vec<String> = out
        .ports()
        .iter()
        .filter_map(|p| out.port_name(p).ok())
        .collect();
    names.dedup();
    names
}

#[cfg(unix)]
fn create_virtual_port() -> Option<MidiOutputConnection> {
    use midir::os::unix::VirtualOutput;
    MidiOutput::new(CLIENT_NAME)
        .ok()?
        .create_virtual(VIRTUAL_PORT_NAME)
        .ok()
}

#[cfg(not(unix))]
fn create_virtual_port() -> Option<MidiOutputConnection> {
    // WinMM has no API for apps to publish their own port; use loopMIDI.
    None
}

fn connect(name: &str) -> Option<MidiOutputConnection> {
    let out = MidiOutput::new(CLIENT_NAME).ok()?;
    let port = out
        .ports()
        .into_iter()
        .find(|p| out.port_name(p).ok().as_deref() == Some(name))?;
    out.connect(&port, CLIENT_NAME).ok()
}

impl Midi {
    fn new() -> Self {
        let virtual_port = create_virtual_port();
        let selection = if virtual_port.is_some() { SEL_VIRTUAL } else { SEL_ALL };
        Midi {
            selection: selection.to_string(),
            virtual_port,
            connections: HashMap::new(),
            failed: Vec::new(),
        }
    }

    /// Open/close connections so they match the selection and the ports that
    /// currently exist. Called on every port-list poll, which handles hot-plug.
    fn sync(&mut self) -> Vec<String> {
        let available = port_names();
        let wanted: Vec<String> = match self.selection.as_str() {
            SEL_VIRTUAL => Vec::new(),
            SEL_ALL => available.clone(),
            name => available.iter().filter(|n| *n == name).cloned().collect(),
        };

        self.connections.retain(|name, _| wanted.contains(name));
        self.failed.retain(|name| wanted.contains(name));
        for name in &wanted {
            if self.connections.contains_key(name) || self.failed.contains(name) {
                continue;
            }
            match connect(name) {
                Some(conn) => {
                    self.connections.insert(name.clone(), conn);
                }
                None => self.failed.push(name.clone()),
            }
        }
        available
    }

    fn info(&mut self) -> MidiInfo {
        let ports = self.sync();
        MidiInfo {
            ports,
            virtual_port: self.virtual_port.as_ref().map(|_| VIRTUAL_PORT_NAME.to_string()),
            selection: self.selection.clone(),
            failed: self.failed.clone(),
        }
    }

    fn send(&mut self, msg: &[u8]) {
        let to_virtual = matches!(self.selection.as_str(), SEL_ALL | SEL_VIRTUAL);
        if to_virtual {
            if let Some(conn) = self.virtual_port.as_mut() {
                let _ = conn.send(msg);
            }
        }
        for conn in self.connections.values_mut() {
            let _ = conn.send(msg);
        }
    }
}

/// List outputs (and reconcile connections with the current port list).
#[tauri::command]
fn midi_outputs(midi: State<Mutex<Midi>>) -> MidiInfo {
    midi.lock().unwrap().info()
}

/// Choose where to send: `__all__`, `__virtual__`, or a port name.
#[tauri::command]
fn midi_select(midi: State<Mutex<Midi>>, selection: String) -> MidiInfo {
    let mut m = midi.lock().unwrap();
    m.selection = selection;
    m.failed.clear(); // let the user retry a port that failed before
    m.info()
}

/// Send one Control Change. `channel` is 0–15, or `None` for all 16 channels.
#[tauri::command]
fn midi_cc(midi: State<Mutex<Midi>>, channel: Option<u8>, controller: u8, value: u8) {
    let (cc, val) = (controller & 0x7F, value.min(127));
    let mut m = midi.lock().unwrap();
    match channel {
        Some(ch) => m.send(&[0xB0 | (ch & 0x0F), cc, val]),
        None => (0..16u8).for_each(|ch| m.send(&[0xB0 | ch, cc, val])),
    }
}

/// LIVE mode: keep the window above other apps and on every Space/desktop.
#[tauri::command]
fn set_live(window: tauri::WebviewWindow, live: bool) -> Result<(), String> {
    window.set_always_on_top(live).map_err(|e| e.to_string())?;
    window.set_visible_on_all_workspaces(live).map_err(|e| e.to_string())
}

/// The UI blocks all network access (CSP + fetch/XHR guard in netguard.js)
/// and reports each attempt here, so it shows up in the terminal output.
#[tauri::command]
fn net_blocked(url: String) {
    eprintln!("[network blocked] {url}");
}

/// Keep tracking + MIDI running at full speed while the window is in the
/// background or covered by other apps (e.g. a DAW).
#[cfg(target_os = "macos")]
mod keep_alive {
    use objc2::{msg_send, runtime::AnyObject, sel};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    /// Opt out of App Nap, which otherwise throttles timers and IPC a few
    /// seconds after the app stops being visible.
    pub fn disable_app_nap() {
        let reason = NSString::from_str("Tracking webcam and sending MIDI");
        let options = NSActivityOptions::UserInitiatedAllowingIdleSystemSleep
            | NSActivityOptions::LatencyCritical;
        let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(options, &reason);
        std::mem::forget(token); // hold the activity for the app's lifetime
    }

    /// WebKit suspends pages whose window is occluded or minimised (no frames,
    /// no timers). Turning occlusion detection off keeps the page "visible".
    ///
    /// # Safety
    /// `webview` must be the WKWebView pointer handed out by Tauri.
    pub unsafe fn keep_webview_visible(webview: *mut std::ffi::c_void) {
        let webview = webview.cast::<AnyObject>();
        let selector = sel!(_setWindowOcclusionDetectionEnabled:);
        let supported: bool = unsafe { msg_send![webview, respondsToSelector: selector] };
        if supported {
            let _: () = unsafe { msg_send![webview, _setWindowOcclusionDetectionEnabled: false] };
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(Midi::new()))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                keep_alive::disable_app_nap();
                if let Some(window) = app.get_webview_window("main") {
                    window.with_webview(|wv| unsafe { keep_alive::keep_webview_visible(wv.inner()) })?;
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            midi_outputs,
            midi_select,
            midi_cc,
            set_live,
            net_blocked
        ])
        .run(tauri::generate_context!())
        .expect("error while running Webcam to MIDI");
}
