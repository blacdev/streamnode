//! The window.
//!
//! On the left, what files can be converted to: each stream that was added,
//! and the user's own settings. On the right, the chosen one: what the stream
//! is, what files become, the advanced settings, and the files themselves.
//!
//! The window is redrawn only when something happens (the mouse, a key, or
//! the worker reporting progress), so the program uses no processor time
//! while it sits open.

use std::{path::PathBuf, sync::Arc};

use eframe::egui::{self, Align, Color32, CornerRadius, Frame, Layout, Margin, RichText, Sense, Stroke};
use egui_phosphor::regular as icon;

use crate::{
    media::{self, khz, KINDS},
    store::{Check, Job, JobState, Level, Shared, State, Target, OWN},
    theme::{self, ico, Palette},
};

const BITRATES: [u32; 12] = [32, 48, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const RATES: [u32; 6] = [22050, 24000, 32000, 44100, 48000, 96000];

pub fn run() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("StreamNode Converter")
            .with_app_id("streamnode-converter")
            .with_inner_size([980.0, 680.0])
            .with_min_inner_size([640.0, 460.0])
            .with_drag_and_drop(true),
        ..Default::default()
    };
    eframe::run_native(
        "StreamNode Converter",
        options,
        Box::new(|cc| {
            theme::install_fonts(&cc.egui_ctx);
            Ok(Box::new(App::new(&cc.egui_ctx)) as Box<dyn eframe::App>)
        }),
    )
}

/// What the user asked for in a frame. Carried out once the frame is drawn,
/// when the shared state is no longer held.
enum Action {
    Detect(u64),
    RemoveTarget(u64),
    PickFiles(u64),
    PickFolder(u64),
    RemoveJob(u64),
    ClearFinished(u64),
    Reveal(PathBuf),
}

#[derive(Default)]
struct AddStream {
    open: bool,
    url: String,
    name: String,
    error: String,
}

struct App {
    shared: Arc<Shared>,
    palette: Palette,
    selected: u64,
    add: AddStream,
    /// Why files could not be added, shown until the next try.
    notice: String,
    /// Files named when the program was started ("Open with"), added once
    /// the chosen stream's format is known.
    waiting: Vec<PathBuf>,
}

impl App {
    fn new(ctx: &egui::Context) -> Self {
        let repaint = ctx.clone();
        let shared = Shared::start(move || repaint.request_repaint());
        let palette = theme::palette(ctx.theme() == egui::Theme::Dark);
        theme::apply(ctx, &palette);
        // What the program was started with: a stream address is added, so that a
        // link or a shortcut can open it ready for that station, and files are queued.
        let (addresses, files): (Vec<String>, Vec<String>) = std::env::args().skip(1).partition(|arg| media::check_url(arg).is_ok());
        let waiting = files.into_iter().map(PathBuf::from).filter(|path| path.is_file()).collect();
        let mut app = Self { shared, palette, selected: OWN, add: AddStream::default(), notice: String::new(), waiting };
        if let Some(url) = addresses.first() {
            app.add_stream(url, "");
        } else if let Some(first) = app.shared.state.lock().unwrap().targets.iter().find(|target| target.is_stream()) {
            app.selected = first.id;
        }
        // Formats are detected again at each start: a station may have changed its stream.
        let streams: Vec<u64> = app.shared.state.lock().unwrap().targets.iter().filter(|target| target.is_stream()).map(|target| target.id).collect();
        if media::available() {
            streams.into_iter().for_each(|id| app.shared.detect(id));
        }
        app
    }

    /// Adds a stream, or selects it if it is already there.
    fn add_stream(&mut self, url: &str, name: &str) {
        let url = url.trim();
        let id = {
            let mut state = self.shared.state.lock().unwrap();
            if let Some(existing) = state.targets.iter().find(|target| target.url == url) {
                self.selected = existing.id;
                return;
            }
            let id = state.new_id();
            let name = if name.trim().is_empty() { name_from(url) } else { name.trim().to_string() };
            state.targets.push(Target { id, name, url: url.to_string(), ..Target::own() });
            state.unsaved = true;
            id
        };
        self.selected = id;
        self.shared.detect(id);
    }

    fn carry_out(&mut self, action: Action) {
        match action {
            Action::Detect(id) => self.shared.detect(id),
            Action::RemoveTarget(id) => {
                let mut state = self.shared.state.lock().unwrap();
                state.targets.retain(|target| target.id != id || target.id == OWN);
                let gone: Vec<u64> = state.jobs.iter().filter(|job| job.target == id).map(|job| job.id).collect();
                state.unsaved = true;
                drop(state);
                gone.into_iter().for_each(|job| self.shared.remove_job(job));
                self.selected = OWN;
            }
            Action::PickFiles(id) => {
                if let Some(files) = rfd::FileDialog::new().set_title("Choose audio or video files").pick_files() {
                    self.add_files(id, files);
                }
            }
            Action::PickFolder(id) => {
                if let Some(folder) = rfd::FileDialog::new().set_title("Save converted files in").pick_folder() {
                    let mut state = self.shared.state.lock().unwrap();
                    if let Some(target) = state.target(id) {
                        target.out_dir = Some(folder);
                    }
                    state.unsaved = true;
                }
            }
            Action::RemoveJob(id) => self.shared.remove_job(id),
            Action::ClearFinished(id) => {
                let mut state = self.shared.state.lock().unwrap();
                state.jobs.retain(|job| job.target != id || matches!(job.state, JobState::Waiting | JobState::Working(_)));
            }
            Action::Reveal(path) => reveal(&path),
        }
    }

    fn add_files(&mut self, target: u64, files: Vec<PathBuf>) {
        self.notice = self.shared.add_files(target, files).err().unwrap_or_default();
    }
}

/// A name for a stream from its address: the last part of the path, or the host.
fn name_from(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let path = rest.split(['?', '#']).next().unwrap_or(rest);
    let mut parts = path.split('/').filter(|part| !part.is_empty());
    let host = parts.next().unwrap_or("Stream");
    let last = parts.next_back().map(|part| part.rsplit_once('.').map_or(part, |(stem, _)| stem)).filter(|part| !part.is_empty() && !matches!(*part, "live" | "stream" | "listen"));
    last.unwrap_or(host.split(':').next().unwrap_or(host)).to_string()
}

/// Shows a file in the system's file manager.
fn reveal(path: &std::path::Path) {
    let folder = path.parent().unwrap_or(path);
    let _ = if cfg!(windows) {
        std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg("-R").arg(path).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(folder).spawn()
    };
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        let dark = ctx.theme() == egui::Theme::Dark;
        if dark != self.palette.dark {
            self.palette = theme::palette(dark);
            theme::apply(&ctx, &self.palette);
        }
        let p = self.palette.clone();

        // Files dropped anywhere on the window go to whatever is selected.
        let dropped: Vec<PathBuf> = ctx.input(|input| input.raw.dropped_files.iter().map(|file| file.path().to_path_buf()).collect());
        if !dropped.is_empty() {
            self.add_files(self.selected, dropped);
        }
        let hovering = ctx.input(|input| !input.raw.hovered_files.is_empty());
        if !self.waiting.is_empty() && self.shared.state.lock().unwrap().target(self.selected).is_some_and(|target| target.check != Check::Detecting) {
            let files = std::mem::take(&mut self.waiting);
            self.add_files(self.selected, files);
        }

        let mut actions = Vec::new();
        let shared = self.shared.clone();
        let mut state = shared.state.lock().unwrap();
        if !state.targets.iter().any(|target| target.id == self.selected) {
            self.selected = OWN;
        }

        egui::Panel::left("targets")
            .exact_size(250.0)
            .resizable(false)
            .show_separator_line(false)
            .frame(Frame::new().fill(p.side).inner_margin(Margin::same(14)))
            .show(ui, |ui| side(ui, &p, &state, &mut self.selected, &mut self.add));

        egui::CentralPanel::no_frame().frame(Frame::new().fill(p.bg)).show(ui, |ui| {
            egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                Frame::new().inner_margin(Margin { left: 24, right: 24, top: 20, bottom: 24 }).show(ui, |ui| {
                    if !media::available() {
                        banner(ui, &p, p.bad, "The converter's engine (ffmpeg) was not found.", "It ships in the same folder as this program. Put the files from the download back together, or install ffmpeg.");
                    }
                    let selected = self.selected;
                    let jobs: Vec<Job> = state.jobs.iter().filter(|job| job.target == selected).cloned().collect();
                    let mut unsaved = false;
                    if let Some(target) = state.target(selected) {
                        unsaved = detail(ui, &p, target, &jobs, &self.notice, hovering, &mut actions);
                    }
                    state.unsaved |= unsaved;
                });
            });
        });

        // Saved once the mouse is let go, so dragging a value does not write the file many times.
        let save = state.unsaved && !ctx.input(|input| input.pointer.any_down());
        drop(state);
        if save {
            self.shared.save();
        }
        self.add_dialog(&ctx, &p);
        actions.into_iter().for_each(|action| self.carry_out(action));
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        self.shared.save();
        self.shared.stop_all();
        // Long enough for the worker to notice and stop ffmpeg, which it checks for five times a second.
        std::thread::sleep(std::time::Duration::from_millis(350));
    }
}

fn side(ui: &mut egui::Ui, p: &Palette, state: &State, selected: &mut u64, add: &mut AddStream) {
    ui.horizontal(|ui| {
        let (rect, _) = ui.allocate_exact_size(egui::vec2(34.0, 34.0), Sense::hover());
        ui.painter().rect_filled(rect, CornerRadius::same(9), p.a1);
        ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, icon::WAVEFORM, egui::FontId::new(20.0, theme::icons()), Color32::WHITE);
        ui.vertical(|ui| {
            ui.spacing_mut().item_spacing.y = 0.0;
            ui.label(RichText::new("Converter").family(theme::bold()).size(16.0));
            ui.label(RichText::new("StreamNode").size(11.5).color(p.text_dim));
        });
    });
    ui.add_space(14.0);
    ui.label(RichText::new("CONVERT FILES TO").size(11.0).color(p.text_faint).family(theme::semibold()));

    egui::Panel::bottom("add-stream").show_separator_line(false).frame(Frame::new().inner_margin(Margin { top: 10, ..Margin::ZERO })).show(ui, |ui| {
        let button = egui::Button::new((ico(icon::PLUS).size(15.0), "Add a stream")).min_size(egui::vec2(ui.available_width(), 34.0));
        if ui.add(button).clicked() {
            *add = AddStream { open: true, ..AddStream::default() };
        }
    });

    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        ui.spacing_mut().item_spacing.y = 6.0;
        for target in &state.targets {
            let chosen = *selected == target.id;
            let working = state.jobs.iter().filter(|job| job.target == target.id && matches!(job.state, JobState::Waiting | JobState::Working(_))).count();
            let line = match (&target.check, &target.format) {
                (Check::Detecting, _) => "Listening to the stream…".to_string(),
                (Check::Failed(_), _) => "Could not be read".to_string(),
                (_, Some(format)) => format.summary(),
                _ if target.is_stream() => "Not checked yet".to_string(),
                _ => target.settings.summary(),
            };
            let fill = if chosen { p.a1_soft } else { Color32::TRANSPARENT };
            let stroke = if chosen { Stroke::new(1.0, theme::alpha(p.a1, 0.6)) } else { Stroke::NONE };
            let card = Frame::new().fill(fill).stroke(stroke).corner_radius(CornerRadius::same(8)).inner_margin(Margin::symmetric(10, 8)).show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 2.0;
                    ui.horizontal(|ui| {
                        ui.label(ico(if target.is_stream() { icon::BROADCAST } else { icon::SLIDERS_HORIZONTAL }).size(15.0).color(if chosen { p.a1 } else { p.text_dim }));
                        ui.add(egui::Label::new(RichText::new(&target.name).family(theme::semibold())).truncate().selectable(false));
                        if working > 0 {
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| ui.label(RichText::new(working.to_string()).size(11.5).color(p.a1)));
                        }
                    });
                    let colour = if matches!(target.check, Check::Failed(_)) { p.bad } else { p.text_dim };
                    ui.add(egui::Label::new(RichText::new(line).size(11.5).color(colour)).truncate().selectable(false));
                });
            });
            if card.response.interact(Sense::click()).on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                *selected = target.id;
            }
        }
    });
}

fn banner(ui: &mut egui::Ui, p: &Palette, colour: Color32, title: &str, text: &str) {
    Frame::new().fill(theme::mix(p.surface, colour, 0.12)).stroke(Stroke::new(1.0, theme::alpha(colour, 0.5))).corner_radius(CornerRadius::same(8)).inner_margin(Margin::same(12)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.vertical(|ui| {
            ui.label(RichText::new(title).family(theme::semibold()).color(colour));
            ui.label(RichText::new(text).size(12.5).color(p.text_dim));
        });
    });
    ui.add_space(6.0);
}

fn card<R>(ui: &mut egui::Ui, p: &Palette, title: &str, body: impl FnOnce(&mut egui::Ui) -> R) -> R {
    let shown = Frame::new().fill(p.surface).stroke(Stroke::new(1.0, p.border)).corner_radius(CornerRadius::same(10)).inner_margin(Margin::same(16)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.vertical(|ui| {
            ui.label(RichText::new(title.to_uppercase()).size(11.0).color(p.text_faint).family(theme::semibold()));
            ui.add_space(2.0);
            body(ui)
        })
        .inner
    });
    ui.add_space(4.0);
    shown.inner
}

/// The chosen target. Returns whether something that is saved was changed.
fn detail(ui: &mut egui::Ui, p: &Palette, target: &mut Target, jobs: &[Job], notice: &str, hovering: bool, actions: &mut Vec<Action>) -> bool {
    let mut changed = false;
    // The buttons are laid out first, from the right, so that the name and
    // address take what is left and are cut short rather than running under them.
    ui.horizontal(|ui| {
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if target.is_stream() {
                if ui.add(egui::Button::new((ico(icon::TRASH).size(15.0).color(p.bad), RichText::new("Remove").color(p.bad)))).clicked() {
                    actions.push(Action::RemoveTarget(target.id));
                }
                let busy = target.check == Check::Detecting;
                if ui.add_enabled(!busy, egui::Button::new((ico(icon::ARROWS_CLOCKWISE).size(15.0), "Check again"))).clicked() {
                    actions.push(Action::Detect(target.id));
                }
            }
            ui.with_layout(Layout::top_down(Align::Min), |ui| {
                ui.spacing_mut().item_spacing.y = 2.0;
                ui.add(egui::Label::new(RichText::new(&target.name).heading()).truncate());
                let under = if target.is_stream() { target.url.clone() } else { "No stream needed: choose the format yourself below.".to_string() };
                ui.add(egui::Label::new(RichText::new(under).size(12.5).color(p.text_dim)).truncate());
            });
        });
    });
    ui.add_space(8.0);

    if target.is_stream() {
        card(ui, p, "The stream", |ui| match (&target.check, &target.format) {
            (Check::Detecting, _) => {
                ui.horizontal(|ui| {
                    ui.spinner();
                    ui.label("Listening to the stream to learn its format and loudness. This takes about ten seconds.");
                });
            }
            (Check::Failed(reason), _) => {
                ui.label(RichText::new("The stream could not be read.").family(theme::semibold()).color(p.bad));
                ui.label(RichText::new(reason).size(12.5).color(p.text_dim));
                if target.format.is_some() {
                    ui.label(RichText::new("The format found last time is still used below.").size(12.5).color(p.text_dim));
                }
            }
            (_, Some(format)) => {
                ui.label(RichText::new(format.summary()).family(theme::semibold()).size(16.0));
                let level = format.level_db.map_or("Its loudness could not be measured.".to_string(), |db| format!("Average loudness {db:.1} dB."));
                ui.label(RichText::new(level).size(12.5).color(p.text_dim));
            }
            _ => {
                ui.label(RichText::new("Not checked yet.").color(p.text_dim));
            }
        });
    }

    changed |= card(ui, p, "Files become", |ui| {
        let mut changed = false;
        ui.label(RichText::new(target.settings.summary()).family(theme::semibold()).size(16.0));
        let he_aac = target.format.as_ref().is_some_and(|format| format.he_aac());
        let unmakeable = target.format.as_ref().is_some_and(|format| format.kind().is_none());
        if he_aac {
            ui.label(RichText::new("This stream is HE-AAC (AAC+), which no free converter is allowed to make. Files become ordinary AAC instead: fine to listen to, but not to be cut into this stream.").size(12.5).color(p.warn));
        } else if unmakeable {
            ui.label(RichText::new("This stream's format is not one the converter makes, so MP3 is suggested. Choose another under Advanced.").size(12.5).color(p.warn));
        } else if target.matches_stream() {
            ui.horizontal(|ui| {
                ui.label(ico(icon::CHECK_CIRCLE).size(15.0).color(p.ok));
                ui.label(RichText::new("Exactly the stream's format.").size(12.5).color(p.ok));
            });
        } else if let Some(format) = target.format.clone().filter(|_| target.changed) {
            ui.horizontal(|ui| {
                ui.label(RichText::new("Changed from the stream's format.").size(12.5).color(p.warn));
                if ui.link("Use the stream's format").clicked() {
                    target.settings = Target::matching(&format);
                    target.level = if format.level_db.is_some() { Level::Stream } else { Level::Keep };
                    target.changed = false;
                    changed = true;
                }
            });
        }
        let loudness = match (target.level, target.format.as_ref().and_then(|format| format.level_db)) {
            (Level::Keep, _) => "Loudness is left as each file has it.".to_string(),
            (Level::Stream, Some(db)) => format!("Loudness is matched to the stream ({db:.1} dB)."),
            (Level::Stream, None) => "Loudness is left as it is until the stream's has been measured.".to_string(),
            (Level::Fixed(db), _) => format!("Loudness is brought to {db:.1} dB."),
        };
        ui.label(RichText::new(loudness).size(12.5).color(p.text_dim));
        ui.add_space(4.0);
        egui::CollapsingHeader::new(RichText::new("Advanced").family(theme::semibold())).id_salt(("advanced", target.id)).default_open(std::env::var_os("STREAMNODE_CONVERTER_ADVANCED").is_some()).show(ui, |ui| changed |= advanced(ui, p, target, actions));
        changed
    });

    card(ui, p, "Files", |ui| {
        ui.horizontal(|ui| {
            let add = egui::Button::new((ico(icon::PLUS).size(15.0).color(Color32::WHITE), RichText::new("Add files").color(Color32::WHITE).family(theme::semibold()))).fill(p.a1);
            if ui.add_enabled(media::available(), add).clicked() {
                actions.push(Action::PickFiles(target.id));
            }
            ui.label(RichText::new("or drop them on this window").size(12.5).color(p.text_dim));
        });
        ui.label(RichText::new("Audio and video both work: the sound is taken out of a video. Your original files are never changed.").size(12.5).color(p.text_dim));
        if !notice.is_empty() {
            ui.label(RichText::new(notice).size(12.5).color(p.bad));
        }
        if hovering {
            Frame::new().fill(p.a1_soft).stroke(Stroke::new(1.0, p.a1)).corner_radius(CornerRadius::same(8)).inner_margin(Margin::same(14)).show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(RichText::new(format!("Drop to convert to {}", target.settings.summary())).family(theme::semibold()).color(p.a1));
            });
        }
        for job in jobs {
            job_row(ui, p, job, actions);
        }
        if jobs.iter().any(|job| matches!(job.state, JobState::Done { .. } | JobState::Failed(_))) {
            ui.horizontal(|ui| {
                if ui.link("Clear finished").clicked() {
                    actions.push(Action::ClearFinished(target.id));
                }
            });
        }
    });
    changed
}

fn advanced(ui: &mut egui::Ui, p: &Palette, target: &mut Target, actions: &mut Vec<Action>) -> bool {
    let before = (target.settings.clone(), target.level, target.name.clone(), target.out_dir.clone());
    let kind = media::kind(&target.settings.kind).unwrap_or(&KINDS[0]);
    let label = |ui: &mut egui::Ui, text: &str| ui.label(RichText::new(text).color(p.text_dim));
    egui::Grid::new(("advanced-grid", target.id)).num_columns(2).spacing([18.0, 10.0]).show(ui, |ui| {
        if target.is_stream() {
            label(ui, "Name");
            ui.add(egui::TextEdit::singleline(&mut target.name).desired_width(240.0));
            ui.end_row();
        }

        label(ui, "Format");
        egui::ComboBox::from_id_salt(("kind", target.id)).selected_text(kind.label).show_ui(ui, |ui| {
            for option in KINDS {
                ui.selectable_value(&mut target.settings.kind, option.key.to_string(), option.label);
            }
        });
        ui.end_row();

        label(ui, "Bitrate");
        if kind.has_bitrate {
            egui::ComboBox::from_id_salt(("bitrate", target.id)).selected_text(format!("{} kbps", target.settings.bitrate_kbps)).show_ui(ui, |ui| {
                let mut options = BITRATES.to_vec();
                if !options.contains(&target.settings.bitrate_kbps) {
                    options.push(target.settings.bitrate_kbps);
                    options.sort_unstable();
                }
                for kbps in options {
                    ui.selectable_value(&mut target.settings.bitrate_kbps, kbps, format!("{kbps} kbps"));
                }
            });
        } else {
            ui.label(RichText::new("Not used: nothing is thrown away").color(p.text_faint));
        }
        ui.end_row();

        label(ui, "Sample rate");
        egui::ComboBox::from_id_salt(("rate", target.id)).selected_text(khz(target.settings.sample_rate)).show_ui(ui, |ui| {
            let mut options = RATES.to_vec();
            if !options.contains(&target.settings.sample_rate) {
                options.push(target.settings.sample_rate);
                options.sort_unstable();
            }
            for rate in options {
                ui.selectable_value(&mut target.settings.sample_rate, rate, khz(rate));
            }
        });
        ui.end_row();

        label(ui, "Channels");
        ui.horizontal(|ui| {
            ui.selectable_value(&mut target.settings.channels, 2, "Stereo");
            ui.selectable_value(&mut target.settings.channels, 1, "Mono");
        });
        ui.end_row();

        label(ui, "Loudness");
        ui.vertical(|ui| {
            ui.spacing_mut().item_spacing.y = 4.0;
            ui.radio_value(&mut target.level, Level::Keep, "Leave each file as loud as it is");
            if target.is_stream() {
                ui.radio_value(&mut target.level, Level::Stream, "Match the stream");
            }
            ui.horizontal(|ui| {
                let mut db = if let Level::Fixed(db) = target.level { db } else { -16.0 };
                if ui.radio(matches!(target.level, Level::Fixed(_)), "Bring to").clicked() {
                    target.level = Level::Fixed(db);
                }
                if ui.add(egui::DragValue::new(&mut db).range(-40.0..=-3.0).speed(0.1).fixed_decimals(1).suffix(" dB")).changed() {
                    target.level = Level::Fixed(db);
                }
            });
        });
        ui.end_row();

        label(ui, "Save in");
        ui.vertical(|ui| {
            ui.spacing_mut().item_spacing.y = 4.0;
            match &target.out_dir {
                None => ui.label("The same folder as each original"),
                Some(folder) => ui.add(egui::Label::new(folder.display().to_string()).truncate()),
            };
            ui.horizontal(|ui| {
                if ui.button("Choose a folder").clicked() {
                    actions.push(Action::PickFolder(target.id));
                }
                if target.out_dir.is_some() && ui.button("Beside the originals").clicked() {
                    target.out_dir = None;
                }
            });
        });
        ui.end_row();
    });
    ui.label(RichText::new("Changes apply to files added from now on. The original file is never changed or replaced.").size(12.0).color(p.text_faint));

    if target.settings != before.0 {
        // Kept within what the format allows, for instance Opus's own sample rates.
        if let Ok(checked) = target.settings.clone().checked() {
            target.settings = checked;
        }
        target.changed = true;
    }
    if target.level != before.1 {
        target.changed = true;
    }
    (target.settings.clone(), target.level, target.name.clone(), target.out_dir.clone()) != before
}

fn job_row(ui: &mut egui::Ui, p: &Palette, job: &Job, actions: &mut Vec<Action>) {
    let name = job.input.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    Frame::new().fill(p.surface2).corner_radius(CornerRadius::same(8)).inner_margin(Margin::symmetric(12, 10)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            let (glyph, colour) = match &job.state {
                JobState::Waiting => (icon::CLOCK, p.text_dim),
                JobState::Working(_) => (icon::WAVEFORM, p.a1),
                JobState::Done { .. } => (icon::CHECK_CIRCLE, p.ok),
                JobState::Failed(_) => (icon::WARNING_CIRCLE, p.bad),
            };
            ui.label(ico(glyph).size(18.0).color(colour));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let active = matches!(job.state, JobState::Waiting | JobState::Working(_));
                if ui.add(egui::Button::new(ico(icon::X).size(14.0)).frame(false)).on_hover_text(if active { "Stop and remove" } else { "Remove from this list" }).clicked() {
                    actions.push(Action::RemoveJob(job.id));
                }
                if let JobState::Done { output, .. } = &job.state {
                    if ui.add(egui::Button::new((ico(icon::FOLDER_OPEN).size(15.0), "Show"))).clicked() {
                        actions.push(Action::Reveal(output.clone()));
                    }
                }
                ui.with_layout(Layout::top_down(Align::Min), |ui| {
                    ui.spacing_mut().item_spacing.y = 3.0;
                    ui.add(egui::Label::new(RichText::new(&name).family(theme::semibold())).truncate());
                    match &job.state {
                        JobState::Waiting => {
                            ui.label(RichText::new(format!("Waiting · to {}", job.settings.summary())).size(12.0).color(p.text_dim));
                        }
                        JobState::Working(done) => {
                            ui.add(egui::ProgressBar::new(*done).desired_height(6.0).fill(p.a1));
                            ui.label(RichText::new(format!("Converting to {} · {:.0}%", job.settings.summary(), done * 100.0)).size(12.0).color(p.text_dim));
                        }
                        JobState::Done { output, gain_db } => {
                            let saved = output.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
                            let gain = if *gain_db == 0.0 { String::new() } else { format!(" · turned {} {:.1} dB", if *gain_db > 0.0 { "up" } else { "down" }, gain_db.abs()) };
                            ui.add(egui::Label::new(RichText::new(format!("Saved as {saved}{gain}")).size(12.0).color(p.text_dim)).truncate());
                        }
                        JobState::Failed(reason) => {
                            ui.add(egui::Label::new(RichText::new(reason).size(12.0).color(p.bad)).wrap());
                        }
                    }
                });
            });
        });
    });
}

impl App {
    fn add_dialog(&mut self, ctx: &egui::Context, p: &Palette) {
        if !self.add.open {
            return;
        }
        let mut submit = false;
        let mut open = true;
        egui::Window::new("Add a stream").open(&mut open).collapsible(false).resizable(false).anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0]).show(ctx, |ui| {
            ui.set_width(420.0);
            ui.label(RichText::new("Stream address").family(theme::semibold()));
            let field = ui.add(egui::TextEdit::singleline(&mut self.add.url).hint_text("https://stream.example.com/station").desired_width(f32::INFINITY));
            if self.add.url.is_empty() && !field.has_focus() {
                field.request_focus();
            }
            ui.label(RichText::new("The address listeners tune in to. The converter listens for a few seconds to learn its format.").size(12.0).color(p.text_dim));
            ui.add_space(4.0);
            ui.label(RichText::new("Name").family(theme::semibold()));
            ui.add(egui::TextEdit::singleline(&mut self.add.name).hint_text("Optional").desired_width(f32::INFINITY));
            if !self.add.error.is_empty() {
                ui.label(RichText::new(&self.add.error).size(12.5).color(p.bad));
            }
            ui.add_space(6.0);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let add = egui::Button::new(RichText::new("Add stream").color(Color32::WHITE).family(theme::semibold())).fill(p.a1);
                submit = ui.add(add).clicked() || ui.input(|input| input.key_pressed(egui::Key::Enter));
                if ui.button("Cancel").clicked() {
                    self.add.open = false;
                }
            });
        });
        if !open {
            self.add.open = false;
        }
        if submit {
            match media::check_url(self.add.url.trim()) {
                Ok(()) => {
                    let (url, name) = (self.add.url.clone(), self.add.name.clone());
                    self.add_stream(&url, &name);
                    self.add.open = false;
                }
                Err(reason) => self.add.error = reason,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::name_from;

    #[test]
    fn a_stream_is_named_after_its_address() {
        assert_eq!(name_from("https://stream.example.com/powerbeats"), "powerbeats");
        assert_eq!(name_from("http://radio.example:8000/jazz.mp3?x=1"), "jazz");
        assert_eq!(name_from("https://radio.example/live"), "radio.example");
        assert_eq!(name_from("https://radio.example:8443/"), "radio.example");
    }
}
