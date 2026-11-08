# Publisher scheduling

A post can go out now, at each platform's next free slot, or on a chosen day. Each destination gets its own time, which can also be set by hand. The laptop helper claims a destination only once its time has come (`publisher_targets.scheduled_at`). If the laptop is asleep then, the post goes out when it wakes.

A scheduled post has to go out before its uploads expire. The bucket removes an upload a week after it went up, so the server refuses a time later than the first upload's expiry, less an hour.

## Posting times

Each platform has its best times of day (best first), the fewest hours between two posts, the most posts in any seven days, its best weekdays, and its audience's time zone. They're saved in the browser under `publisher.schedule.v1`, and the composer's **Posting times** panel edits them.

- **Next free slot** takes each platform's first day that keeps its gap and its posts a week from what it already has out or scheduled, on one of its days. It uses the best time still open that day.
- **On a day** takes each platform's best time on that day that hasn't passed, whatever the weekday.

## Defaults

The defaults are from studies of when posts do best, in the audience's local time, gathered on 2026-11-07 for a small account posting short vertical videos. Few sources publish a minimum gap, so the gaps are judgements.

| Platform | Times | Gap (h) | A week | Days | Basis |
| --- | --- | --- | --- | --- | --- |
| Instagram | 18:00, 12:00, 21:00 | 18 | 4 | Mon–Thu | Buffer: Reels do best 6–11 p.m., best on Wed/Thu; 3–5 posts a week reach about 12% more per post than 1–2. Sprout: Mon–Thu afternoons. 18:00 is in both windows. |
| TikTok | 18:00, 21:00, 13:00 | 4 | 5 | any | Buffer (7.1M posts): evenings 6–11 p.m.; start with 2–5 a week. Sprout: Tue–Thu, 2–6 p.m. They disagree on days. |
| YouTube | 16:00, 18:00, 19:00 | 12 | 4 | any | Shorts. Buffer (1.8M videos) and Adobe both put 4 p.m. first; Thu–Sat do best. vidIQ: channels posting about 3 a week grew 4× faster than those posting under once a month. |
| X / Twitter | 09:00, 13:00, 10:00 | 4 | 7 | any | Buffer (8.7M posts): 9 a.m. on most days, Tue–Thu best. Sprout: 12–6 p.m. Hootsuite: 2–3 posts a day overall. |
| Bluesky | 20:00, 17:00, 09:00 | 4 | 5 | any | Buffer (3M posts): weekday peaks 8–9 p.m., weekends strong. SocialPilot: 9–11 a.m. and 6–8 p.m. Neither gives a frequency. |
| Farcaster | 10:00, 14:00 | 4 | 5 | Mon–Fri | Inferred. The only data: engagement peaks slightly mid-morning US Eastern, and consistency matters more than timing. |
| Lens | 10:00, 20:00 | 12 | 3 | any | Inferred. No published data; a small crypto audience like Farcaster's. |
| Xiaohongshu | 20:00, 12:00, 07:30 (China time) | 24 | 3 | any | Chinese guides agree on 19:00–22:00, then lunch (12:00–13:30) and the morning commute. They range from 2–3 posts a week to 1–2 a day, and warn new accounts against more than one a day. |
| Grain | 20:00, 17:00 | 24 | 3 | any | Inferred. Its users sign in with Bluesky, so it borrows Bluesky's evenings, at an Instagram feed's pace. It takes photo posts only. |

For long YouTube videos, Buffer finds Sunday at 10 a.m. best. Change YouTube's times when posting those.

## Sources

- Buffer, best time to post on Instagram (2026): https://buffer.com/resources/when-is-the-best-time-to-post-on-instagram/
- Buffer, how often to post on Instagram (2025): https://buffer.com/resources/how-often-to-post-on-instagram/
- Sprout Social, best times to post on Instagram (2026): https://sproutsocial.com/insights/best-times-to-post-on-instagram/
- Buffer, best time to post on TikTok (2026): https://buffer.com/resources/best-time-to-post-on-tiktok/
- Buffer, how often to post on TikTok (2025): https://buffer.com/resources/how-often-should-you-post-on-tiktok/
- Sprout Social, best times to post on TikTok (2026): https://sproutsocial.com/insights/best-times-to-post-on-tiktok/
- Buffer, best time to post on YouTube (2026): https://buffer.com/resources/best-time-to-post-on-youtube/
- Adobe Express, best times to post YouTube Shorts (2025): https://www.adobe.com/express/learn/blog/best-times-to-post-youtube-shorts
- vidIQ, how often to post on YouTube (2026): https://vidiq.com/blog/post/How-Often-Post-on-Youtube
- Buffer, best time to post on X (2026): https://buffer.com/resources/best-time-to-post-on-twitter-x
- Sprout Social, best times to post on X (2026): https://sproutsocial.com/insights/best-times-to-post-on-twitter/
- Hootsuite, how often to post on social media (2025): https://blog.hootsuite.com/how-often-to-post-on-social-media/
- Buffer, best time to post on Bluesky (2026): https://buffer.com/resources/best-time-to-post-on-bluesky/
- SocialPilot, best time to post on Bluesky (2026): https://www.socialpilot.co/insights/best-time-to-post-on-bluesky
- GM Farcaster, Farcaster 101 module 9 (2024): https://paragraph.com/@gmfarcaster/farcaster-101-module-9
- Hashmeta, best times to post on Xiaohongshu (2025): https://hashmeta.com/blog/best-times-to-post-on-xiaohongshu-in-2025-backed-by-data
- 搜狐 (2025): https://www.sohu.com/a/894708139_121833257
- 蚁小二 (2024): https://xueyuan.yixiaoer.cn/article/21886
