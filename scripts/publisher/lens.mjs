import { MediaImageMimeType, MediaVideoMimeType, image, textOnly, video } from "@lens-protocol/metadata";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { lens as lensChain } from "viem/chains";
import { chainConfig, sendEip712Transaction } from "viem/zksync";
import { createGrove, MAX_UPLOAD_BYTES } from "./grove.mjs";
import { posterFrame } from "./hls.mjs";
import { deleteKey, ethereumKey, readKey, rejected, sleep } from "./protocol.mjs";

/** kualta's account. */
export const account = "0x1C03475F4ceA795F255282774A762979f9550611";
// Logging in names an app. This is the one Lens provides for anyone without their own.
export const app = "0x8A5Cc31180c37078e1EbA2A23c861Acf351a97cE";
const KEY = "lens-manager";
const API = "https://api.lens.xyz/graphql";
const chain = defineChain({ ...lensChain, ...chainConfig });

async function gql(query, variables, { fetcher, token }) {
  const response = await fetcher(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://post.kualta.dev",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const { data, errors } = await response.json();
  // A refusal is an answer. A lost connection isn't: with signless posting, the post may have gone out.
  if (errors?.length) throw rejected(errors[0].message);
  return data;
}
const operation = (name, success) => `mutation($request: ${name === "post" ? "CreatePostRequest" : "DeletePostRequest"}!) {
  ${name}(request: $request) {
    __typename
    ... on ${success} { hash }
    ... on TransactionWillFail { reason }
    ${name === "post" ? "... on PostOperationValidationFailed { reason }" : ""}
    ... on SelfFundedTransactionRequest { raw { from to nonce gasLimit maxFeePerGas maxPriorityFeePerGas data value } }
    ... on SponsoredTransactionRequest {
      raw {
        from to nonce gasLimit maxFeePerGas maxPriorityFeePerGas data value
        customData { paymasterParams { paymaster paymasterInput } }
      }
    }
  }
}`;
async function login(manager, fetcher) {
  let tokens;
  try {
    const { challenge } = await gql(
      "mutation($request: ChallengeRequest!) { challenge(request: $request) { id text } }",
      { request: { accountManager: { account, app, manager: manager.address } } },
      { fetcher },
    );
    const signature = await manager.signMessage({ message: challenge.text });
    ({ authenticate: tokens } = await gql(
      `mutation($request: SignedAuthChallenge!) {
        authenticate(request: $request) {
          __typename
          ... on AuthenticationTokens { accessToken }
          ... on WrongSignerError { reason }
          ... on ExpiredChallengeError { reason }
          ... on ForbiddenError { reason }
        }
      }`,
      { request: { id: challenge.id, signature } },
      { fetcher },
    ));
  } catch (error) {
    throw rejected(error.message);
  }
  if (tokens.__typename !== "AuthenticationTokens") throw rejected(tokens.reason);
  return tokens.accessToken;
}
const readBalance = (address) => createPublicClient({ chain, transport: http() }).getBalance({ address });
/** Sends what Lens asks for. Which it asks for depends on whether something sponsors this account's posts on this app. */
export async function sendRequest(request, manager, { balanceOf = readBalance, transport = http() } = {}) {
  const { raw, __typename } = request;
  if (raw.from.toLowerCase() !== manager.address.toLowerCase())
    throw rejected("Lens asked another wallet to send this. Connect Lens again.");
  const wallet = createWalletClient({ account: manager, chain, transport });
  const fields = {
    account: manager,
    data: raw.data,
    gas: BigInt(raw.gasLimit),
    maxFeePerGas: BigInt(raw.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(raw.maxPriorityFeePerGas),
    nonce: raw.nonce,
    to: raw.to,
    value: BigInt(raw.value),
  };
  if (__typename === "SponsoredTransactionRequest")
    return sendEip712Transaction(wallet, {
      ...fields,
      paymaster: raw.customData.paymasterParams?.paymaster,
      paymasterInput: raw.customData.paymasterParams?.paymasterInput,
    });
  const cost = fields.gas * fields.maxFeePerGas;
  if ((await balanceOf(manager.address)) < cost)
    throw rejected(
      `Lens isn't sponsoring this, and gas for it can cost up to ${formatEther(cost)} GHO. Send some GHO on Lens Chain to ${manager.address}, then retry.`,
    );
  return wallet.sendTransaction({ ...fields, type: "eip1559" });
}
async function settle(result, manager, send) {
  if (result.hash) return result.hash;
  if (result.__typename === "SponsoredTransactionRequest" || result.__typename === "SelfFundedTransactionRequest")
    return send(result, manager);
  throw rejected(result.reason || "Lens refused this.");
}
/** True once indexed; false if it's still going after two minutes, when the outcome is unknown. */
async function indexed(hash, { fetcher, wait }) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const { transactionStatus: status } = await gql(
      `query($request: TransactionStatusRequest!) {
        transactionStatus(request: $request) { __typename ... on FailedTransactionStatus { reason } }
      }`,
      { request: { txHash: hash } },
      { fetcher },
    ).catch(() => ({ transactionStatus: {} }));
    if (status.__typename === "FinishedTransactionStatus") return true;
    if (status.__typename === "FailedTransactionStatus") throw rejected(`Lens: ${status.reason}`);
    await wait(3000);
  }
  return false;
}
async function loadManager(stateDir) {
  const key = await readKey(stateDir, KEY);
  if (!key) throw rejected("Connect Lens in the composer first.");
  return privateKeyToAccount(key);
}
/** Lens's post formats want the first picture on its own, then the rest, with no empty descriptions. */
async function buildMetadata(files, infos, post, grove, { signal, poster }) {
  const shared = {
    ...(post.caption.trim() ? { content: post.caption } : {}),
    ...(post.tags?.length ? { tags: post.tags.filter((tag) => tag.length <= 50) } : {}),
  };
  const described = (text) => (text?.trim() ? { altTag: text } : {});
  if (post.kind === "photo") {
    const items = [];
    for (let i = 0; i < files.length; i++) {
      const { uri } = await grove.upload(files[i], "image/jpeg");
      items.push({ item: uri, type: MediaImageMimeType.JPEG, ...described(post.alts?.[i] ?? post.alt) });
    }
    const [first, ...rest] = items;
    return image({ ...shared, image: first, ...(rest.length ? { attachments: rest } : {}) });
  }
  if (post.kind === "video") {
    if (infos[0].bytes > MAX_UPLOAD_BYTES) throw rejected("Grove takes files up to 125 MB.");
    const { uri } = await grove.upload(files[0], "video/mp4");
    const frame = await poster(files[0], join(dirname(files[0]), "poster.jpg"), infos[0].duration, { signal });
    const cover = await grove.upload(frame, "image/jpeg");
    return video({
      ...shared,
      video: {
        item: uri,
        type: MediaVideoMimeType.MP4,
        cover: cover.uri,
        duration: Math.max(1, Math.round(infos[0].duration)),
        ...described(post.alt),
      },
    });
  }
  return textOnly(shared);
}
export async function publishLens(
  files,
  infos,
  post,
  {
    stateDir,
    signal,
    fetcher = fetch,
    wait = sleep,
    send = sendRequest,
    poster = posterFrame,
    grove = createGrove(stateDir, `lens-${post.id}`),
  },
) {
  const manager = await loadManager(stateDir);
  const token = await login(manager, fetcher);
  let contentUri;
  try {
    const metadata = await buildMetadata(files, infos, post, grove, { signal, poster });
    ({ uri: contentUri } = await grove.uploadJson(metadata));
  } catch (error) {
    await grove.remove().catch(() => {});
    throw rejected(error.message);
  }
  const { post: result } = await gql(operation("post", "PostResponse"), { request: { contentUri } }, { fetcher, token });
  const hash = await settle(result, manager, send);
  if (!(await indexed(hash, { fetcher, wait })))
    return { uncertain: true, message: `Lens hasn't indexed transaction ${hash} yet. Check the account before retrying.` };
  for (let attempt = 0; attempt < 10; attempt++) {
    const { post: created } = await gql(
      "query($request: PostRequest!) { post(request: $request) { ... on Post { slug } } }",
      { request: { txHash: hash } },
      { fetcher },
    ).catch(() => ({ post: null }));
    if (created?.slug) return { url: `https://hey.xyz/posts/${created.slug}` };
    await wait(3000);
  }
  return { uncertain: true, message: `Transaction ${hash} went through, but Lens hasn't shown its post yet.` };
}
export async function deleteLensPost(
  slug,
  {
    stateDir,
    publication,
    fetcher = fetch,
    wait = sleep,
    send = sendRequest,
    grove = createGrove(stateDir, `lens-${publication}`),
  },
) {
  const { post: found } = await gql(
    "query($request: PostRequest!) { post(request: $request) { ... on Post { id isDeleted } } }",
    { request: { post: slug } },
    { fetcher },
  );
  if (!found?.id || found.isDeleted) {
    await grove.remove().catch(() => {});
    return { state: "deleted", message: "Already removed from Lens" };
  }
  const manager = await loadManager(stateDir);
  const token = await login(manager, fetcher);
  const { deletePost: result } = await gql(
    operation("deletePost", "DeletePostResponse"),
    { request: { post: found.id } },
    { fetcher, token },
  );
  const hash = await settle(result, manager, send);
  if (!(await indexed(hash, { fetcher, wait })))
    return { state: "uncertain", message: `Lens hasn't indexed transaction ${hash} yet. Check the post before retrying.` };
  const leftover = await grove.remove().catch(() => true);
  return { state: "deleted", message: leftover ? "Deleted from Lens. Its media stays on Grove." : "Deleted from Lens" };
}
export async function lensMetrics(slug, { fetcher = fetch } = {}) {
  const { post } = await gql(
    `query($request: PostRequest!) {
      post(request: $request) { ... on Post { isDeleted stats { comments reposts quotes reactions bookmarks } } }
    }`,
    { request: { post: slug } },
    { fetcher },
  );
  if (!post?.stats || post.isDeleted) throw new Error("Post not found");
  return {
    likes: post.stats.reactions,
    comments: post.stats.comments,
    shares: post.stats.reposts + post.stats.quotes,
    saves: post.stats.bookmarks,
  };
}
/**
 * The laptop holds its own key instead of the account's wallet. Adding it as a manager takes the owner's signature in
 * a Lens app, so this shows the address and waits until Lens lets it log in.
 */
export async function connectLens(active, { stateDir, report, fetcher = fetch, wait = sleep }) {
  const manager = await ethereumKey(stateDir, KEY);
  await report(
    `Add ${manager.address} as an account manager at https://hey.xyz/settings/manager with your wallet. It only needs to execute transactions, so leave token transfers off. Waiting for Lens to list it…`,
  );
  const deadline = Date.now() + 10 * 60_000;
  let failure;
  while (Date.now() < deadline) {
    await active();
    try {
      await login(manager, fetcher);
      return;
    } catch (error) {
      failure = error;
    }
    await wait(5000);
  }
  throw new Error(`Lens didn't accept the key in time: ${failure?.message}. Connect again.`);
}
/** Lens only lets the owner's wallet remove a manager, so forgetting the key here is what this side can do. */
export async function disconnectLens({ stateDir }) {
  await deleteKey(stateDir, KEY);
}
