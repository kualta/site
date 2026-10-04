const did = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
let counter = 0;
const agent = {
  post: async (record: unknown) => {
    if ((window as any).failPost) throw new Error("Fixture publication rejected");
    await new Promise((resolve) => setTimeout(resolve, 100));
    (window as any).written = record;
    (window as any).ackAt = performance.now();
    return {
      uri: `at://${did}/app.bsky.feed.post/fixture${++counter}`,
      cid: "bafyreid3l3mpwbadpafmoajnc2ukaaf42cmnti6shcomrrqnqq4ctap5xy",
    };
  },
  uploadBlob: async () => ({
    data: {
      blob: {
        $type: "blob",
        ref: { $link: "bafkreigh2akiscaildc6o7fva5yfxvqgye5dj3jhmlwsjh56pdnuzuqkby" },
        mimeType: "image/jpeg",
        size: 100,
      },
    },
  }),
};
const snapshot = {
  agent,
  canUploadMedia: true,
  loading: false,
  error: null,
  profile: { did, handle: "kualta.dev", displayName: "ku" },
};
export const getBlueskyAgent = async () => agent;
export const getBlueskyAuthSnapshot = () => snapshot;
export const getBlueskyAuthServerSnapshot = () => snapshot;
export const subscribeBlueskyAuth = () => () => {};
export const initializeBlueskyAuth = async () => {};
export const signIn = async () => {};
export const signOut = async () => {};
