/** The frame at `seconds` into a video file, as a JPEG at the video's own size. Rejects when this browser can't decode it. */
export function frameAt(file: File, seconds: number, name = "cover.jpg"): Promise<File> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const fail = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This browser can't read a frame of this video; upload a cover image instead."));
    };
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onerror = fail;
    video.onloadeddata = () => {
      const target = Math.min(Math.max(0, seconds), Math.max(0, video.duration - 0.05));
      // Seeking to where it already is fires no "seeked".
      video.currentTime = target === video.currentTime ? target + 0.001 : target;
    };
    video.onseeked = () => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context || !canvas.width) return fail();
      context.drawImage(video, 0, 0);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(url);
          if (blob) resolve(new File([blob], name, { type: "image/jpeg" }));
          else reject(new Error("Could not take the frame"));
        },
        "image/jpeg",
        0.92,
      );
    };
    video.src = url;
  });
}
