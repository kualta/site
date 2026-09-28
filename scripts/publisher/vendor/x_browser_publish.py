#!/usr/bin/env python3
"""Publish a post to X (Twitter) by driving the web composer UI.

Reuses the session saved by x_browser_login.py and runs headless by default.
Because the post is typed and sent through X's own composer, the request is
generated and signed by X's web client (unlike a hand-crafted API call), which
is the whole point of the browser method. X changes its markup and A/B tests
layouts, so each step tries several selectors and fails with a clear message.
"""
import argparse
import re
import time
from pathlib import Path

from browser_publish_verification import (
    classify_x_publish_response,
    is_x_publish_response,
)
from x_browser_lib import (
    COMPOSE_URL,
    HOME_URL,
    emit,
    first_page,
    friendly_error,
    import_playwright,
    is_logged_in,
    launch_persistent,
)

STEP_TIMEOUT_MS = 60_000

# Proof the media ACTUALLY landed: the blob preview image/video or the Remove button.
# (The bare [data-testid="attachments"] container can exist empty, so it is NOT used here
# or it gives a false positive and the post goes out text-only.)
MEDIA_PREVIEW_SELECTOR = (
    '[aria-label="Remove media"], [data-testid="removeMedia"], '
    'img[src^="blob:"], [data-testid="attachments"] img, '
    '[data-testid="attachments"] video, video[src^="blob:"]'
)


def media_attached(page):
    try:
        return page.locator(MEDIA_PREVIEW_SELECTOR).first.is_visible(timeout=1000)
    except Exception:
        return False


def wait_upload_complete(page, kind, timeout_ms):
    """After the preview appears, X keeps uploading in the background and disables
    Post until done. Wait for any progress indicator to clear so we never click
    Post mid-upload (which drops the media)."""
    settle = max(timeout_ms, 300_000) if kind == "video" else 60_000
    waited = 0
    while waited < settle:
        try:
            busy = page.locator('[role="progressbar"]').first.is_visible(timeout=400)
        except Exception:
            busy = False
        if not busy:
            break
        page.wait_for_timeout(1000)
        waited += 1000
    page.wait_for_timeout(3000 if kind == "video" else 1500)


def parse_args():
    parser = argparse.ArgumentParser(description="Publish a post to X via the web composer.")
    parser.add_argument("--user-data-dir", required=True)
    parser.add_argument("--text", default="")
    parser.add_argument("--media", default="")
    parser.add_argument("--kind", choices=["image", "video", "none"], default="none")
    parser.add_argument("--headless", choices=["true", "false"], default="true")
    parser.add_argument("--timeout-ms", type=int, default=180_000)

    return parser.parse_args()


def open_composer(page):
    """Opens the X composer and returns the editable textbox locator."""
    try:
        page.goto(COMPOSE_URL, wait_until="domcontentloaded")
    except Exception:
        # Fall back to home + the inline composer if /compose/post is blocked.
        try:
            page.goto(HOME_URL, wait_until="domcontentloaded")
        except Exception:
            pass

    page.wait_for_timeout(2500)

    # X keeps a background inline composer AND the modal one in the DOM, each with its
    # own textarea + file input. Prefer the modal ([role="dialog"]) so text, media, and
    # Post all target the SAME composer (otherwise media lands in the other one and the
    # post goes out text-only).
    selectors = [
        '[role="dialog"] [data-testid="tweetTextarea_0"]',
        'div[data-testid="tweetTextarea_0"]',
        '[role="dialog"] div[aria-label="Post text"]',
        'div[aria-label="Post text"]',
        'div[role="textbox"][contenteditable="true"]',
    ]
    for sel in selectors:
        try:
            box = page.locator(sel).first
            box.wait_for(state="visible", timeout=12_000)
            return box
        except Exception:
            continue

    raise RuntimeError(
        "Could not open the X composer. X may have changed its layout, or this session "
        "needs Log in to X again."
    )


def type_text(page, box, text):
    if not text:
        return
    try:
        box.click()
        page.wait_for_timeout(300)
        # type() dispatches real key events so X's React composer registers the input.
        # Long Premium posts (up to 25k chars) would crawl at a per-key delay, so drop it.
        delay = 0 if len(text) > 2000 else 4
        page.keyboard.type(text, delay=delay)
    except Exception as exc:
        raise RuntimeError("Could not type the post text into the X composer.") from exc


def attach_media(page, media_path, kind, timeout_ms):
    # Use the file input inside the SAME modal composer as the textarea/Post button.
    # (Plain .last grabs the background inline composer's input, so the media never
    # makes it onto the posted tweet.)
    file_input = None
    for sel in (
        '[role="dialog"] input[data-testid="fileInput"]',
        '[role="dialog"] input[type="file"]',
        'input[data-testid="fileInput"]',
        'input[type="file"]',
    ):
        loc = page.locator(sel).first
        try:
            loc.wait_for(state="attached", timeout=STEP_TIMEOUT_MS)
            file_input = loc
            break
        except Exception:
            continue

    if file_input is None:
        raise RuntimeError("Could not find the X media upload control.")

    file_input.set_input_files(media_path)

    # 1) Wait for the REAL preview (blob image/video or Remove button) so we know the
    #    file actually loaded into the composer, not just an empty container.
    wait_ms = max(timeout_ms, 300_000) if kind == "video" else 90_000
    waited = 0
    while waited < wait_ms:
        if media_attached(page):
            break
        page.wait_for_timeout(1000)
        waited += 1000

    if not media_attached(page):
        raise RuntimeError(
            "Media did not attach in the X composer (no preview appeared). X may have changed the "
            "upload control or rejected the file. Set X browser headless to false to watch the flow."
        )

    # 2) Wait for the background upload to finish so Post never fires mid-upload (which
    #    is what was dropping the media and posting text-only).
    wait_upload_complete(page, kind, timeout_ms)


def post_button(page):
    for sel in (
        '[role="dialog"] [data-testid="tweetButton"]',
        '[data-testid="tweetButton"]',
        '[role="dialog"] [data-testid="tweetButtonInline"]',
        '[data-testid="tweetButtonInline"]',
    ):
        loc = page.locator(sel).first
        try:
            if loc.count() > 0:
                return loc
        except Exception:
            continue
    return page.locator('[data-testid="tweetButton"]').first


def click_post(page, enable_timeout_ms):
    btn = post_button(page)
    try:
        btn.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
    except Exception as exc:
        raise RuntimeError("Could not find the X Post button.") from exc

    # Wait until X enables the button (text/media accepted; video must finish processing).
    waited = 0
    while waited < enable_timeout_ms:
        try:
            disabled = btn.get_attribute("aria-disabled")
        except Exception:
            disabled = None
        if disabled != "true":
            break
        page.wait_for_timeout(1000)
        waited += 1000

    try:
        btn.click(timeout=10_000)
        return
    except Exception:
        pass
    try:
        btn.click(timeout=10_000, force=True)
    except Exception:
        # Keyboard shortcut as a last resort (Cmd/Ctrl+Enter posts).
        try:
            page.keyboard.press("Meta+Enter")
        except Exception as exc:
            raise RuntimeError("Found the X Post button but could not click it.") from exc


def track_publish_response(response, outcome):
    """Capture X's definitive CreateTweet/CreateNoteTweet web response."""
    try:
        method = response.request.method
        url = response.url
    except Exception:
        return

    if not is_x_publish_response(url, method):
        return

    try:
        payload = response.json()
    except Exception:
        payload = None

    classified = classify_x_publish_response(url, method, response.status, payload)

    if classified is not None:
        outcome.clear()
        outcome.update(classified)


def toast_publish_outcome(page):
    toast = page.locator('[data-testid="toast"]').first

    try:
        if not toast.is_visible(timeout=250):
            return None
        text = toast.inner_text(timeout=1000)
    except Exception:
        return None

    href = None
    try:
        link = toast.locator('a[href*="/status/"]').first
        if link.count() > 0:
            href = link.get_attribute("href", timeout=1000)
    except Exception:
        pass

    if re.search(r"sent|posted", text, re.I):
        outcome = {"ok": True, "message": "X confirmed the post."}
        if href:
            outcome["url"] = ("https://x.com" + href) if href.startswith("/") else href
        return outcome

    if re.search(r"failed|error|went wrong|try again|not sent", text, re.I):
        return {"ok": False, "message": text.strip() or "X rejected the post."}

    return None


def wait_for_sent(page, composer, response_outcome, timeout_ms):
    """Wait for a network confirmation, then fall back to transient UI signals."""
    deadline = time.monotonic() + max(timeout_ms, 10_000) / 1000
    composer_closed_at = None

    while time.monotonic() < deadline:
        if response_outcome:
            return dict(response_outcome)

        toast_outcome = toast_publish_outcome(page)
        if toast_outcome is not None:
            return toast_outcome

        try:
            composer_visible = composer.is_visible(timeout=250)
        except Exception:
            composer_visible = False

        if not composer_visible:
            composer_closed_at = composer_closed_at or time.monotonic()
            # Give the CreateTweet response/toast a moment to arrive before using
            # the modal closing as a secondary success signal.
            if time.monotonic() - composer_closed_at >= 2:
                return {"ok": True, "message": "X closed the composer after posting."}
        else:
            composer_closed_at = None

        page.wait_for_timeout(250)

    return {
        "ok": False,
        "uncertain": True,
        "message": (
            "X publish outcome is unknown: no CreateTweet response or success UI was "
            "observed. Do not retry automatically; check the profile first."
        ),
    }


def run_publish(context, args):
    page = first_page(context)
    page.set_default_timeout(STEP_TIMEOUT_MS)

    try:
        page.goto(HOME_URL, wait_until="domcontentloaded")
    except Exception:
        pass
    page.wait_for_timeout(2500)

    if not is_logged_in(context):
        return {
            "ok": False,
            "message": (
                "This X profile is not logged in. Click Log in to X in Settings, finish "
                "signing in, then publish again."
            ),
        }

    box = open_composer(page)
    type_text(page, box, args.text)

    if args.kind in ("image", "video") and args.media:
        attach_media(page, args.media, args.kind, args.timeout_ms)
        # Final guard right before sending: if the preview vanished, do NOT post text-only.
        if not media_attached(page):
            raise RuntimeError(
                "Media is not attached right before posting; aborting so it does not go out as a "
                "text-only post."
            )

    response_outcome = {}
    page.on("response", lambda response: track_publish_response(response, response_outcome))
    click_post(page, 180_000 if args.kind == "video" else 30_000)

    outcome = wait_for_sent(page, box, response_outcome, args.timeout_ms)
    if outcome.get("ok"):
        result = {
            "ok": True,
            "message": ("Published with %s" % args.kind) if args.kind != "none" else "Published",
        }
        if outcome.get("url"):
            result["url"] = outcome["url"]
        return result

    return {
        "ok": False,
        **({"uncertain": True} if outcome.get("uncertain") else {}),
        "message": outcome.get("message") or "X rejected the post.",
    }


def main():
    args = parse_args()

    if args.kind in ("image", "video"):
        media_paths = json.loads(args.media) if args.media.startswith("[") else [args.media]
        args.media = media_paths
        if not args.media or not all(Path(path).expanduser().is_file() for path in media_paths):
            emit({"ok": False, "message": "X media file was not found."}, 2)

    sync_playwright = import_playwright()
    result = {"ok": False, "message": "X publish did not complete."}

    with sync_playwright() as playwright:
        context = None

        try:
            context = launch_persistent(
                playwright, args.user_data_dir, headless=args.headless == "true"
            )
            result = run_publish(context, args)
        except Exception as exc:
            try:
                if context is not None and context.pages:
                    shot = Path(args.user_data_dir).expanduser() / "last-error.png"
                    context.pages[0].screenshot(path=str(shot))
            except Exception:
                pass
            result = {"ok": False, "message": friendly_error(exc)}
        finally:
            if context is not None:
                try:
                    context.close()
                except Exception:
                    pass

    emit(result, 0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
