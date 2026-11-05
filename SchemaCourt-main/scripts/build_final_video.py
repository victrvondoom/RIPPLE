#!/usr/bin/env python3
"""
scripts/build_final_video.py
Builds a complete, no-voiceover "Brag Repo" Launch Video + Stitched Demo MP4:
1. Renders animated dark-mode HTML/CSS Intro, Section Cards, and Outro via Playwright.
2. Burns clear lower-third explanation banners onto clip1(final).mp4, clip2(final).mp4, and clip3.mp4.
3. Adds freeze-frames to the end of Clip 1 (Red Dashboard) and Clip 3 (Green Recovery).
4. Concatenates everything into SchemaCourt_Final_Submission.mp4.
"""
import shutil
import subprocess
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE_DIR = Path(__file__).resolve().parent.parent
OUT_DIR = BASE_DIR / "build_video"

# Automatically locate your 3 clips in project root, videos/ subfolder, or Videos screen recordings
def find_clip(candidates: list[str]) -> Path:
    search_folders = [
        BASE_DIR,
        BASE_DIR / "videos",
        Path("C:/Users/mihee/Videos/Screen Recordings"),
        Path.cwd()
    ]
    for folder in search_folders:
        for name in candidates:
            p = folder / name
            if p.exists():
                return p
    raise FileNotFoundError(
        f"Could not find {candidates[0]} in {search_folders}. "
        f"Place your clips in {BASE_DIR} and re-run."
    )


SLIDES_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif; }
  body {
    width: 1920px; height: 1080px; overflow: hidden;
    background: radial-gradient(circle at 20% 20%, #111827 0%, #090d16 65%, #05070c 100%);
    color: #f8fafc; display: flex; align-items: center; justify-content: center;
  }
  .slide {
    width: 1560px; padding: 64px 72px; border-radius: 24px;
    background: rgba(15, 23, 42, 0.88); border: 2px solid #1e293b;
    box-shadow: 0 25px 70px rgba(0,0,0,0.65);
    animation: popIn 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .eyebrow {
    display: inline-block; padding: 8px 18px; border-radius: 999px;
    font-size: 18px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase;
    margin-bottom: 26px; background: #1e3a8a; color: #93c5fd; border: 1px solid #3b82f6;
  }
  .eyebrow.red { background: #7f1d1d; color: #fca5a5; border-color: #ef4444; }
  .eyebrow.green { background: #064e3b; color: #6ee7b7; border-color: #10b981; }
  .eyebrow.purple { background: #4c1d95; color: #ddd6fe; border-color: #8b5cf6; }
  h1 { font-size: 64px; font-weight: 900; line-height: 1.12; margin-bottom: 24px; letter-spacing: -1px; }
  p.lead { font-size: 30px; color: #cbd5e1; line-height: 1.45; margin-bottom: 36px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; margin-top: 20px; }
  .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-top: 28px; }
  .card {
    background: #090d16; border: 1px solid #334155; border-radius: 16px; padding: 26px 28px;
  }
  .card-title { font-size: 22px; font-weight: 800; color: #38bdf8; margin-bottom: 10px; }
  .card-body { font-size: 21px; color: #e2e8f0; line-height: 1.4; }
  .stat-num { font-size: 46px; font-weight: 900; color: #10b981; margin-bottom: 6px; font-family: Consolas, monospace; }
  .code-pill {
    font-family: Consolas, monospace; background: #1e293b; color: #38bdf8;
    padding: 4px 12px; border-radius: 8px; font-size: 0.9em;
  }
  @keyframes popIn {
    from { opacity: 0; transform: translateY(14px) scale(0.985); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
</style>
</head>
<body>
  <div id="stage"></div>
  <script>
    window.showSlide = function(htmlContent) {
      document.getElementById('stage').innerHTML = `<div class="slide">${htmlContent}</div>`;
    };
  </script>
</body>
</html>
"""


SLIDE_CONTENTS = {
    "intro_1_problem": (
        4.5,
        """
        <span class="eyebrow red">⚠️ THE SILENT PRODUCTION KILLER</span>
        <h1>Backend Ships <span class="code-pill">v3.0</span>. Tests Pass.<br>Downstream Revenue Quietly Breaks.</h1>
        <p class="lead">
          When <span class="code-pill">checkout-service</span> moves top-level <span class="code-pill">discount_cents</span>
          into <span class="code-pill">promo_struct.discount_cents</span>, the microservice build succeeds—while the
          Gold SQL model (<span class="code-pill">fct_revenue.sql</span>) evaluates to <b style="color:#f87171;">NULL</b> across 100,000 rows.
        </p>
        <div class="grid">
          <div class="card">
            <div class="card-title" style="color:#f87171;">❌ Why Standard Chatbots & CI Fail</div>
            <div class="card-body">CI alerts dump noisy red logs without a fix. Solo terminal agents only see one repo and cannot coordinate human sign-off.</div>
          </div>
          <div class="card">
            <div class="card-title" style="color:#34d399;">✅ What Teams Actually Need</div>
            <div class="card-body">An evidence-backed review room where Backend, Data Owner, and AI inspect impact, verify a compatible patch, and log approval.</div>
          </div>
        </div>
        """
    ),
    "intro_2_brag": (
        5.0,
        """
        <span class="eyebrow">⚖️ FLIP THE SWITCH HACKATHON</span>
        <h1>SchemaCourt — Change Review Room for Data Contracts</h1>
        <p class="lead">
          Bridging <span class="code-pill">@Claude Code</span> into Telegram via <b>Switch AI</b> to investigate schema drift,
          propose backward-compatible SQL, and verify parity before merge.
        </p>
        <div class="grid-4">
          <div class="card">
            <div class="stat-num">100,000</div>
            <div class="card-body">Parquet Fixture Rows Checked (Legacy + Drifted)</div>
          </div>
          <div class="card">
            <div class="stat-num">$17.2M</div>
            <div class="card-body">Baseline Contract Net Revenue Protected</div>
          </div>
          <div class="card">
            <div class="stat-num">&lt; 20ms</div>
            <div class="card-body">In-Memory DuckDB Dual-Contract Audit</div>
          </div>
          <div class="card">
            <div class="stat-num" style="color:#a78bfa;">Wispr</div>
            <div class="card-body">Live Voice Approval in Shared Chat</div>
          </div>
        </div>
        """
    ),
    "card_step1": (
        2.5,
        """
        <span class="eyebrow">PART 1 OF 3 • THE BREAKING PRODUCER CHANGE</span>
        <h1>Baseline Contract Passing ($17.2M) ➔ Schema Drift Simulated</h1>
        <p class="lead">
          Watch the live Streamlit Contract Monitor as <span class="code-pill">checkout-service@v3.0.0-stripe</span>
          deprecates <span class="code-pill">discount_cents</span> and breaks <span class="code-pill">models/fct_revenue.sql</span>.
        </p>
        """
    ),
    "card_step2": (
        2.8,
        """
        <span class="eyebrow">PART 2 OF 3 • EVIDENCE-BACKED INVESTIGATION IN SWITCH</span>
        <h1><span class="code-pill">@SchemaCourtBot</span> Separates Verified Facts from Proposals</h1>
        <p class="lead">
          Inside the Telegram Switch Room, Claude Code inspects the 100k-row Parquet stream, reports exact NULL counts,
          proposes a <span class="code-pill">COALESCE</span> patch, and pauses for <span class="code-pill">@maya_data</span> approval.
        </p>
        """
    ),
    "card_step3": (
        2.8,
        """
        <span class="eyebrow purple">PART 3 OF 3 • WISPR FLOW VOICE SIGN-OFF & DUAL VERIFICATION</span>
        <h1>Voice Approval ➔ Live SQL Patch ➔ $0.00 Delta Verified</h1>
        <p class="lead">
          Watch the bottom-center <b>Wispr Flow</b> dictation bar as the Data Owner approves by voice—triggering dual-fixture
          DuckDB verification and flipping the live dashboard back to <b style="color:#34d399;">GREEN</b>.
        </p>
        """
    ),
    "outro_brag": (
        4.5,
        """
        <span class="eyebrow green">✅ CONTRACT VERIFIED & RECORDED IN SWITCH</span>
        <h1>SchemaCourt: Zero Silent Data Outages.</h1>
        <p class="lead">
          <b>Detect ➔ Investigate ➔ Propose ➔ Human Voice Approval (Wispr Flow) ➔ Dual-Fixture Verify ➔ Record</b>
        </p>
        <div class="grid">
          <div class="card">
            <div class="card-title">🛠️ Built With</div>
            <div class="card-body">Switch AI • Claude Code • Telegram • Wispr Flow • DuckDB • PyArrow Parquet • Streamlit</div>
          </div>
          <div class="card">
            <div class="card-title" style="color:#34d399;">📊 Final Verification Result</div>
            <div class="card-body">100,000 Legacy Rows + 100,000 Drifted Rows = <b>$17,200,000.00 Net Revenue ($0.00 Variance)</b></div>
          </div>
        </div>
        """
    ),
}


def get_ffmpeg_bin() -> str:
    """Finds imageio_ffmpeg or system ffmpeg."""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        sys_ffmpeg = shutil.which("ffmpeg")
        if sys_ffmpeg:
            return sys_ffmpeg
        return "ffmpeg"


def run_ffmpeg(ffmpeg_bin: str, args: list[str]) -> None:
    cmd = [ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error"] + args
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"FFmpeg error:\n{res.stderr}")


def render_slide_clip(ffmpeg_bin: str, html_path: Path, key: str, duration: float, out_mp4: Path) -> None:
    """Records a high-res HTML slide via Playwright and normalizes it to 1920x1080 30fps MP4."""
    tmp_dir = OUT_DIR / f"_tmp_{key}"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    _, html_body = SLIDE_CONTENTS[key]

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            record_video_dir=str(tmp_dir),
            record_video_size={"width": 1920, "height": 1080},
        )
        page = context.new_page()
        page.goto(html_path.as_uri())
        page.evaluate("(html) => window.showSlide(html)", html_body)
        time.sleep(duration + 0.3)
        video = page.video
        context.close()
        browser.close()
        raw_webm = Path(video.path())

    run_ffmpeg(
        ffmpeg_bin,
        [
            "-i", str(raw_webm),
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-t", str(duration),
            "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x090D16,fps=30,format=yuv420p",
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            str(out_mp4),
        ],
    )
    shutil.rmtree(tmp_dir, ignore_errors=True)


def normalize_demo_clip(ffmpeg_bin: str, src_mp4: Path, out_mp4: Path, tag: str, text: str, freeze_end_sec: float = 0.0) -> None:
    """Normalizes a recorded clip to 1920x1080 @ 30fps with lower-third banner and freeze-frame."""
    tpad_filter = f",tpad=stop_mode=clone:stop_duration={freeze_end_sec}" if freeze_end_sec > 0 else ""
    font_bold = "C\\:/Windows/Fonts/segoeuib.ttf"
    font_reg = "C\\:/Windows/Fonts/segoeui.ttf"

    escaped_tag = tag.replace(":", "\\:").replace("'", "\\'").replace("%", "\\%")
    escaped_text = text.replace(":", "\\:").replace("'", "\\'").replace("%", "\\%")

    banner_filter = (
        f",drawbox=y=ih-115:color=black@0.85:width=iw:height=115:t=fill"
        f",drawbox=y=ih-115:color=0x38BDF8:width=iw:height=4:t=fill"
        f",drawtext=fontfile='{font_bold}':text='{escaped_tag}':fontsize=22:fontcolor=0x38BDF8:x=60:y=h-92"
        f",drawtext=fontfile='{font_reg}':text='{escaped_text}':fontsize=26:fontcolor=white:x=60:y=h-58"
    )

    vf_chain = (
        f"scale=1920:1080:force_original_aspect_ratio=decrease,"
        f"pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30{banner_filter}{tpad_filter},format=yuv420p"
    )
    run_ffmpeg(
        ffmpeg_bin,
        [
            "-i", str(src_mp4),
            "-vf", vf_chain,
            "-af", "apad",
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            str(out_mp4),
        ],
    )


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ffmpeg_bin = get_ffmpeg_bin()
    print(f"Using FFmpeg at: {ffmpeg_bin}")

    clip1_src = find_clip(["clip1(final).mp4", "clip1.mp4"])
    clip2_src = find_clip(["clip2(final).mp4", "clip2.mp4"])
    clip3_src = find_clip(["clip3.mp4", "clip3(final).mp4"])

    print(f"Found clips:\n  1: {clip1_src.name}\n  2: {clip2_src.name}\n  3: {clip3_src.name}")

    html_path = OUT_DIR / "slides.html"
    html_path.write_text(SLIDES_HTML, encoding="utf-8")

    # 1. Render Intro & Section Title Slides
    for idx, (key, (dur, _)) in enumerate(SLIDE_CONTENTS.items(), 1):
        out_slide = OUT_DIR / f"slide_{key}.mp4"
        print(f"[{idx}/9] Rendering kinetic slide '{key}' ({dur}s)...", flush=True)
        render_slide_clip(ffmpeg_bin, html_path, key, dur, out_slide)

    # 2. Normalize the 3 recorded demo clips (+ lower-third banners + freeze frames)
    c1_norm = OUT_DIR / "demo_clip1.mp4"
    c2_norm = OUT_DIR / "demo_clip2.mp4"
    c3_norm = OUT_DIR / "demo_clip3.mp4"

    print("[7/9] Processing Clip 1 (+ banner & +3s freeze on Red Failing Dashboard)...", flush=True)
    normalize_demo_clip(
        ffmpeg_bin, clip1_src, c1_norm,
        tag="PART 1: THE BREAKING CHANGE",
        text="checkout-service drops discount_cents -> $17.2M revenue evaluates to NULL",
        freeze_end_sec=3.0
    )

    print("[8/9] Processing Clip 2 (+ banner & +2s freeze on Switch AI Investigation)...", flush=True)
    normalize_demo_clip(
        ffmpeg_bin, clip2_src, c2_norm,
        tag="PART 2: EVIDENCE-BACKED INVESTIGATION",
        text="Claude Code isolates drift, generates COALESCE patch, and pauses for @maya_data",
        freeze_end_sec=2.0
    )

    print("[9/9] Processing Clip 3 (+ banner & +4s freeze on Wispr Flow & Recovery)...", flush=True)
    normalize_demo_clip(
        ffmpeg_bin, clip3_src, c3_norm,
        tag="PART 3: WISPR FLOW VOICE SIGN-OFF & PARITY AUDIT",
        text="Data Owner voice approval -> 200,000 rows audited in <50ms -> Dashboard flips GREEN",
        freeze_end_sec=4.0
    )

    # 3. Assemble final ordered sequence
    ordered_files = [
        OUT_DIR / "slide_intro_1_problem.mp4",
        OUT_DIR / "slide_intro_2_brag.mp4",
        OUT_DIR / "slide_card_step1.mp4",
        c1_norm,
        OUT_DIR / "slide_card_step2.mp4",
        c2_norm,
        OUT_DIR / "slide_card_step3.mp4",
        c3_norm,
        OUT_DIR / "slide_outro_brag.mp4",
    ]

    concat_list = OUT_DIR / "concat_list.txt"
    concat_list.write_text(
        "\n".join(f"file '{p.as_posix()}'" for p in ordered_files),
        encoding="utf-8"
    )

    final_output = BASE_DIR / "SchemaCourt_Final_Submission.mp4"
    final_output_videos = Path("C:/Users/mihee/Videos/Screen Recordings/SchemaCourt_Final_Submission.mp4")

    print("Stitching final 1080p MP4...", flush=True)
    run_ffmpeg(
        ffmpeg_bin,
        [
            "-f", "concat", "-safe", "0",
            "-i", str(concat_list),
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-c:a", "aac", "-b:a", "192k",
            str(final_output),
        ],
    )
    shutil.copy2(final_output, final_output_videos)
    print(f"\nSUCCESS! Your complete submission video is ready at:\n   1. {final_output}\n   2. {final_output_videos}")


if __name__ == "__main__":
    main()

