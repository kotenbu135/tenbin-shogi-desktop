// Windows のリリースビルドでコンソール窓を出さない。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tenbin_shogi_gui_lib::run()
}
