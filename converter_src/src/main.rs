//! StreamNode Converter: a small desktop program that converts audio and
//! video files into the format of a radio stream, or any format you set.

// On Windows, use the GUI subsystem so no console window opens behind the app.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod app;
mod media;
mod store;
mod theme;

fn main() -> eframe::Result {
    app::run()
}
