use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

#[derive(Default, Clone)]
struct CatHitbox {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

// Combined state shared between commands and the cursor-watcher thread.
#[derive(Default)]
struct AppState {
    hitbox:    CatHitbox,
    drag_mode: bool, // true while cat is being dragged → always receive events
}

#[derive(serde::Serialize, Clone, Copy)]
struct CursorPos {
    x: i32,
    y: i32,
}

// Frontend reports the cat's bounding box (physical px) so Rust can toggle
// click-through based on whether the cursor overlaps the cat.
#[tauri::command]
fn update_hitbox(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) {
    let mut s = state.lock().unwrap();
    s.hitbox = CatHitbox { x, y, w, h };
}

// Frontend calls this to move Oreo's window as she walks / is dragged.
#[tauri::command]
fn set_window_position(app: tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "window not found".to_string())?
        .set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

// Frontend calls set_drag_mode(true) on mousedown to keep events flowing
// even when the cursor drifts outside the cat hitbox mid-drag.
#[tauri::command]
fn set_drag_mode(state: tauri::State<'_, Arc<Mutex<AppState>>>, active: bool) {
    state.lock().unwrap().drag_mode = active;
}

// Spawn a global input listener using rdev (keyboard + scroll wheel).
// Requires Input Monitoring / Accessibility permission on macOS.
// If the permission is not granted rdev returns an error — we log and skip.
fn start_keyboard_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let last_scroll = std::sync::Arc::new(std::sync::Mutex::new(
            std::time::Instant::now()
                .checked_sub(std::time::Duration::from_millis(100))
                .unwrap_or_else(std::time::Instant::now),
        ));
        let result = rdev::listen(move |event: rdev::Event| {
            match event.event_type {
                rdev::EventType::KeyPress(_) => {
                    let _ = app.emit("key-pressed", ());
                }
                rdev::EventType::Wheel { delta_x, delta_y } => {
                    let mut last = last_scroll.lock().unwrap();
                    let now = std::time::Instant::now();
                    if now.duration_since(*last).as_millis() >= 50 {
                        *last = now;
                        let delta =
                            (delta_x.saturating_abs() + delta_y.saturating_abs()).min(30) as f64;
                        drop(last);
                        let _ = app.emit("scroll-wheel", delta);
                    }
                }
                _ => {}
            }
        });
        if let Err(e) = result {
            eprintln!(
                "[oreo] global input listener unavailable: {:?}\n\
                 → Grant Input Monitoring / Accessibility in System Settings → Privacy & Security",
                e
            );
        }
    });
}

// Poll OS cursor every 50 ms:
//   1. Toggle click-through: pass events only over cat (or always during drag).
//   2. Emit "cursor-moved" to JS for activity tracking, eye follow, hunt velocity.
fn start_cursor_watcher(app: tauri::AppHandle, state: Arc<Mutex<AppState>>) {
    std::thread::spawn(move || {
        let mut prev_x = -9999.0_f64;
        let mut prev_y = -9999.0_f64;

        loop {
            std::thread::sleep(std::time::Duration::from_millis(50));

            let Some(window)  = app.get_webview_window("main") else { continue; };
            let Ok(cursor)    = app.cursor_position()           else { continue; };
            let Ok(win_pos)   = window.outer_position()         else { continue; };

            let s = state.lock().unwrap();
            let cx = cursor.x as i32 - win_pos.x;
            let cy = cursor.y as i32 - win_pos.y;
            let over_cat = cx >= s.hitbox.x && cx < s.hitbox.x + s.hitbox.w
                        && cy >= s.hitbox.y && cy < s.hitbox.y + s.hitbox.h;
            let dragging = s.drag_mode;
            drop(s);

            // During drag always receive events; otherwise only over cat.
            let _ = window.set_ignore_cursor_events(!over_cat && !dragging);

            if (cursor.x - prev_x).abs() > 2.0 || (cursor.y - prev_y).abs() > 2.0 {
                prev_x = cursor.x;
                prev_y = cursor.y;
                let _ = app.emit(
                    "cursor-moved",
                    CursorPos {
                        x: cursor.x as i32,
                        y: cursor.y as i32,
                    },
                );
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state: Arc<Mutex<AppState>> = Arc::new(Mutex::new(AppState::default()));
    let state_for_setup = state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .setup(move |app| {
            let window = app.get_webview_window("main").unwrap();

            // Pin to bottom-right of primary monitor, above the Dock.
            if let Ok(Some(monitor)) = window.current_monitor() {
                let sw    = monitor.size().width  as f64;
                let sh    = monitor.size().height as f64;
                let scale = monitor.scale_factor();
                let ww    = 200.0 * scale;
                let wh    = 200.0 * scale;
                let x     = (sw - ww - 20.0 * scale).round() as i32;
                let y     = (sh - wh - 80.0 * scale).round() as i32;
                window.set_position(tauri::PhysicalPosition::new(x, y))?;
            }

            // Click-through by default; watcher re-enables over the cat.
            window.set_ignore_cursor_events(true)?;

            start_cursor_watcher(app.handle().clone(), state_for_setup);
            start_keyboard_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            update_hitbox,
            set_window_position,
            set_drag_mode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
