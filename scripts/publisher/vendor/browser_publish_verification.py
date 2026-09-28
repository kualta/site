"""Pure helpers for classifying browser-driven social publish responses.

X and Instagram can close or redraw their composers before their success UI is
observable. Their web clients still receive a definitive publish response, so
the Playwright scripts use these helpers to classify that response without
depending on transient toast text.
"""


def _error_message(payload, fallback):
    if isinstance(payload, dict):
        errors = payload.get("errors")
        if isinstance(errors, list) and errors:
            first = errors[0]
            if isinstance(first, dict):
                message = first.get("message") or first.get("summary")
                if message:
                    return str(message)
            if first:
                return str(first)

        for key in ("message", "error_message", "error_title"):
            message = payload.get(key)
            if message:
                return str(message)

    return fallback


def is_x_publish_response(url, method):
    return str(method).upper() == "POST" and any(
        marker in str(url) for marker in ("/CreateTweet", "/CreateNoteTweet")
    )


def _x_tweet_result(payload):
    if not isinstance(payload, dict):
        return None

    data = payload.get("data")
    if not isinstance(data, dict):
        return None

    create = data.get("create_tweet") or data.get("create_note_tweet")
    if not isinstance(create, dict):
        return None

    tweet_results = create.get("tweet_results")
    if not isinstance(tweet_results, dict):
        return None

    result = tweet_results.get("result")

    while isinstance(result, dict) and isinstance(result.get("result"), dict):
        result = result["result"]

    return result if isinstance(result, dict) else None


def classify_x_publish_response(url, method, status, payload):
    """Return a definitive publish outcome, or None for an unrelated/ambiguous response."""
    if not is_x_publish_response(url, method):
        return None

    if status < 200 or status >= 300:
        return {
            "ok": False,
            "message": _error_message(payload, f"X rejected the post (HTTP {status})."),
        }

    if isinstance(payload, dict) and payload.get("errors"):
        return {
            "ok": False,
            "message": _error_message(payload, "X rejected the post."),
        }

    result = _x_tweet_result(payload)

    if result is None:
        return None

    tweet_id = result.get("rest_id")
    outcome = {"ok": True, "message": "X confirmed the post."}

    if tweet_id:
        outcome["url"] = f"https://x.com/i/status/{tweet_id}"

    return outcome


INSTAGRAM_PUBLISH_PATHS = (
    "/api/v1/media/configure/",
    "/api/v1/media/configure_to_clips/",
    "/api/v1/web/create/configure/",
)


def is_instagram_publish_response(url, method):
    return str(method).upper() == "POST" and any(
        marker in str(url) for marker in INSTAGRAM_PUBLISH_PATHS
    )


def classify_instagram_publish_response(url, method, status, payload, kind):
    """Return a definitive Instagram publish outcome, or None when still ambiguous."""
    if not is_instagram_publish_response(url, method):
        return None

    if status < 200 or status >= 300:
        return {
            "ok": False,
            "message": _error_message(
                payload, f"Instagram rejected the post (HTTP {status})."
            ),
        }

    if not isinstance(payload, dict):
        return None

    response_status = str(payload.get("status", "")).lower()

    if response_status in ("fail", "error") or payload.get("errors"):
        return {
            "ok": False,
            "message": _error_message(payload, "Instagram rejected the post."),
        }

    media = payload.get("media")
    media = media if isinstance(media, dict) else {}
    shortcode = media.get("code") or media.get("shortcode") or payload.get("code")
    media_id = media.get("pk") or media.get("id") or payload.get("media_id")

    if response_status != "ok" and not media_id:
        return None

    outcome = {"ok": True, "message": "Instagram confirmed the post."}

    if shortcode:
        path = "reel" if kind == "video" else "p"
        outcome["url"] = f"https://www.instagram.com/{path}/{shortcode}/"

    return outcome
