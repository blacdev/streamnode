//! How the window looks: fonts, colours for the dark and light themes, and
//! egui's spacing. Everything drawn takes its colours from [`Palette`].

use eframe::egui::{
    self, Color32, CornerRadius, FontData, FontDefinitions, FontFamily, FontId, Margin, Stroke, TextStyle,
    Vec2, Visuals,
};
use std::sync::Arc;

pub const FONT_SEMIBOLD: &str = "semibold";
pub const FONT_BOLD: &str = "bold";

pub const ICON_FONT: &str = "phosphor";

/// Font family containing only the Phosphor icons.
pub fn icons() -> FontFamily {
    FontFamily::Name(ICON_FONT.into())
}

/// An icon glyph as a `RichText` in the icon family. Combine with text via
/// egui atoms: `Button::new((ico(icon::PLUS), "Add"))`.
pub fn ico(glyph: &str) -> egui::RichText {
    egui::RichText::new(glyph).family(icons())
}

pub fn semibold() -> FontFamily {
    FontFamily::Name(FONT_SEMIBOLD.into())
}
pub fn bold() -> FontFamily {
    FontFamily::Name(FONT_BOLD.into())
}

/// Install Inter (UI), JetBrains Mono (numbers) and Phosphor (icons).
pub fn install_fonts(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();
    let add = |fonts: &mut FontDefinitions, name: &str, bytes: &'static [u8]| {
        fonts.font_data.insert(name.to_owned(), Arc::new(FontData::from_static(bytes)));
    };
    add(&mut fonts, "inter", include_bytes!("../assets/fonts/Inter-Regular.ttf"));
    add(&mut fonts, "inter-semibold", include_bytes!("../assets/fonts/Inter-SemiBold.ttf"));
    add(&mut fonts, "inter-bold", include_bytes!("../assets/fonts/Inter-Bold.ttf"));
    add(&mut fonts, "jbmono", include_bytes!("../assets/fonts/JetBrainsMono-Medium.ttf"));

    fonts.families.insert(FontFamily::Proportional, vec!["inter".into()]);
    fonts.families.insert(FontFamily::Monospace, vec!["jbmono".into(), "inter".into()]);
    fonts.families.insert(semibold(), vec!["inter-semibold".into()]);
    fonts.families.insert(bold(), vec!["inter-bold".into()]);

    // Icons get their own family and are never mixed into a text font chain:
    // Inter has glyphs at some of Phosphor's private-use codepoints (icons
    // would render as stray letters), and Phosphor has ligature glyphs for
    // a–z (text would vanish). Render icons as separate pieces via `ico()`.
    // Registered by hand: egui_phosphor's `add_font_bytes_as_family` copies the
    // text chain into the family (Inter first), which reintroduces the clash.
    add(&mut fonts, ICON_FONT, egui_phosphor::Variant::Regular.font_bytes());
    fonts.families.insert(icons(), vec![ICON_FONT.into()]);
    ctx.set_fonts(fonts);
}

#[derive(Clone)]
pub struct Palette {
    pub dark: bool,
    pub bg: Color32,
    pub side: Color32,
    pub surface: Color32,
    pub surface2: Color32,
    pub border: Color32,
    pub text: Color32,
    pub text_dim: Color32,
    pub text_faint: Color32,
    /// The accent and its shades.
    pub a1: Color32,
    pub a1_soft: Color32,
    pub ok: Color32,
    pub warn: Color32,
    pub bad: Color32,
}

pub fn mix(a: Color32, b: Color32, t: f32) -> Color32 {
    let t = t.clamp(0.0, 1.0);
    let f = |x: u8, y: u8| (x as f32 + (y as f32 - x as f32) * t).round() as u8;
    Color32::from_rgb(f(a.r(), b.r()), f(a.g(), b.g()), f(a.b(), b.b()))
}

pub fn alpha(c: Color32, a: f32) -> Color32 {
    Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), (a.clamp(0.0, 1.0) * 255.0) as u8)
}

/// The same colours as the StreamNode dashboard, so the two feel like one product.
pub fn palette(dark: bool) -> Palette {
    if dark {
        let surface = Color32::from_rgb(0x1A, 0x1D, 0x24);
        let a1 = Color32::from_rgb(0x3B, 0x82, 0xF6);
        Palette {
            dark,
            bg: Color32::from_rgb(0x11, 0x13, 0x18),
            side: Color32::from_rgb(0x15, 0x18, 0x1E),
            surface,
            surface2: Color32::from_rgb(0x22, 0x26, 0x2F),
            border: Color32::from_rgb(0x2C, 0x31, 0x3B),
            text: Color32::from_rgb(0xE9, 0xEC, 0xF1),
            text_dim: Color32::from_rgb(0x9A, 0xA3, 0xB2),
            text_faint: Color32::from_rgb(0x66, 0x6E, 0x7C),
            a1,
            a1_soft: mix(surface, a1, 0.20),
            ok: Color32::from_rgb(0x4A, 0xDE, 0x80),
            warn: Color32::from_rgb(0xFB, 0xBF, 0x24),
            bad: Color32::from_rgb(0xF8, 0x71, 0x71),
        }
    } else {
        let surface = Color32::WHITE;
        let a1 = Color32::from_rgb(0x25, 0x63, 0xEB);
        Palette {
            dark,
            bg: Color32::from_rgb(0xF6, 0xF7, 0xF9),
            side: Color32::from_rgb(0xEC, 0xEF, 0xF3),
            surface,
            surface2: Color32::from_rgb(0xF1, 0xF3, 0xF6),
            border: Color32::from_rgb(0xDD, 0xE1, 0xE7),
            text: Color32::from_rgb(0x16, 0x19, 0x1F),
            text_dim: Color32::from_rgb(0x56, 0x5F, 0x6D),
            text_faint: Color32::from_rgb(0x8E, 0x97, 0xA5),
            a1,
            a1_soft: mix(surface, a1, 0.12),
            ok: Color32::from_rgb(0x15, 0x80, 0x3D),
            warn: Color32::from_rgb(0xB4, 0x53, 0x09),
            bad: Color32::from_rgb(0xB9, 0x1C, 0x1C),
        }
    }
}

/// Apply palette + spacing + type scale to egui.
pub fn apply(ctx: &egui::Context, p: &Palette) {
    let mut v = if p.dark { Visuals::dark() } else { Visuals::light() };
    v.panel_fill = p.bg;
    v.window_fill = p.surface;
    v.window_stroke = Stroke::new(1.0, p.border);
    v.extreme_bg_color = if p.dark { Color32::from_rgb(0x0B, 0x0D, 0x11) } else { p.surface2 };
    v.faint_bg_color = p.surface2;
    v.override_text_color = Some(p.text);
    v.hyperlink_color = p.a1;
    v.selection.bg_fill = alpha(p.a1, 0.35);
    v.selection.stroke = Stroke::new(1.0, p.a1);
    v.window_corner_radius = CornerRadius::same(12);
    v.menu_corner_radius = CornerRadius::same(10);
    v.slider_trailing_fill = true;

    let r = CornerRadius::same(7);
    let w = &mut v.widgets;
    w.noninteractive.bg_fill = p.surface;
    w.noninteractive.weak_bg_fill = p.surface;
    w.noninteractive.bg_stroke = Stroke::new(1.0, p.border);
    w.noninteractive.fg_stroke = Stroke::new(1.0, p.text_dim);
    w.noninteractive.corner_radius = r;
    w.inactive.bg_fill = p.surface2;
    w.inactive.weak_bg_fill = p.surface2;
    w.inactive.bg_stroke = Stroke::new(1.0, p.border);
    w.inactive.fg_stroke = Stroke::new(1.0, p.text);
    w.inactive.corner_radius = r;
    w.hovered.bg_fill = mix(p.surface2, p.a1, 0.10);
    w.hovered.weak_bg_fill = mix(p.surface2, p.a1, 0.10);
    w.hovered.bg_stroke = Stroke::new(1.0, alpha(p.a1, 0.7));
    w.hovered.fg_stroke = Stroke::new(1.5, p.text);
    w.hovered.corner_radius = r;
    w.active.bg_fill = mix(p.surface2, p.a1, 0.22);
    w.active.weak_bg_fill = mix(p.surface2, p.a1, 0.22);
    w.active.bg_stroke = Stroke::new(1.0, p.a1);
    w.active.fg_stroke = Stroke::new(1.5, p.text);
    w.active.corner_radius = r;
    w.open.bg_fill = p.surface2;
    w.open.weak_bg_fill = p.surface2;
    w.open.bg_stroke = Stroke::new(1.0, p.a1);
    w.open.corner_radius = r;
    ctx.set_visuals(v);

    ctx.global_style_mut(|s| {
        s.spacing.item_spacing = Vec2::new(10.0, 10.0);
        s.spacing.button_padding = Vec2::new(14.0, 7.0);
        s.spacing.interact_size = Vec2::new(40.0, 30.0);
        s.spacing.slider_width = 200.0;
        s.spacing.combo_width = 240.0;
        s.spacing.window_margin = Margin::same(16);
        s.spacing.menu_margin = Margin::same(8);
        s.text_styles = [
            (TextStyle::Small, FontId::new(11.5, FontFamily::Proportional)),
            (TextStyle::Body, FontId::new(14.0, FontFamily::Proportional)),
            (TextStyle::Button, FontId::new(14.0, FontFamily::Proportional)),
            (TextStyle::Heading, FontId::new(22.0, bold())),
            (TextStyle::Monospace, FontId::new(13.0, FontFamily::Monospace)),
        ]
        .into();
    });
}
