// The desktop shell is deliberately empty: the app is the same Vite bundle the
// PWA ships, so anything the reader does stays in the web layer.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
