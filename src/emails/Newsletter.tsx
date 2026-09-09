import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Link,
  Markdown,
  Preview,
  Row,
  Section,
  Text,
} from "react-email";

// Email-safe counterparts of the site's light palette and corner marks.
const colors = {
  background: "#f8f8f8",
  text: "#191817",
  muted: "#686461",
  accent: "#ffe7f1",
};
const fontFamily = "Arial, Helvetica, sans-serif";

export interface NewsletterProps {
  title: string;
  preview: string;
  paragraphs?: string[];
  markdown?: string;
  articleUrl: string;
  unsubscribeUrl?: string;
  buttonLabel?: string;
  footerText?: string;
  trackingPixelUrl?: string;
}

function Corners({ bottom = false }: { bottom?: boolean }) {
  const edge = bottom ? { borderBottom: `2px solid ${colors.text}` } : { borderTop: `2px solid ${colors.text}` };
  return (
    <Row aria-hidden="true">
      <Column
        width="24"
        height="24"
        style={{ ...edge, borderLeft: `2px solid ${colors.text}`, borderRadius: bottom ? "0 0 0 8px" : "8px 0 0 0" }}
      />
      <Column />
      <Column
        width="24"
        height="24"
        style={{ ...edge, borderRight: `2px solid ${colors.text}`, borderRadius: bottom ? "0 0 8px 0" : "0 8px 0 0" }}
      />
    </Row>
  );
}

export default function Newsletter({
  title,
  preview,
  paragraphs = [],
  markdown,
  articleUrl,
  unsubscribeUrl = "https://kualta.dev/newsletter/unsubscribe",
  buttonLabel = "Read on the website",
  footerText = "You've received this email because you're subscribed to my newsletter on kualta.dev.",
  trackingPixelUrl,
}: NewsletterProps) {
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={{ margin: 0, backgroundColor: colors.background, color: colors.text, fontFamily }}>
        <Section style={{ padding: "12px" }}>
          <Corners />
          <Container style={{ maxWidth: "640px", margin: "0 auto", padding: "0 12px" }}>
            <Section style={{ padding: "0 0 24px" }}>
              <Button
                href={articleUrl}
                style={{
                  backgroundColor: colors.accent,
                  color: colors.text,
                  borderRadius: "10px",
                  padding: "13px 18px",
                  marginBottom: "28px",
                  fontSize: "15px",
                  fontFamily,
                }}
              >
                {buttonLabel}
              </Button>
              <Section>
                <Heading
                  as="h1"
                  style={{
                    fontSize: "36px",
                    lineHeight: "44px",
                    fontWeight: 600,
                    letterSpacing: "-0.5px",
                    margin: "0 0 24px",
                    color: colors.text,
                  }}
                >
                  {title}
                </Heading>
                {markdown ? (
                  <Markdown
                    markdownContainerStyles={{
                      fontFamily,
                      fontSize: "16px",
                      lineHeight: "27px",
                      color: colors.text,
                    }}
                    markdownCustomStyles={{
                      p: { margin: "0 0 20px", fontSize: "16px", lineHeight: "27px", color: colors.text },
                      h1: { color: colors.text, margin: "28px 0 16px" },
                      h2: { color: colors.text, margin: "28px 0 16px" },
                      h3: { color: colors.text, fontSize: "21px", margin: "28px 0 16px" },
                      link: { color: colors.text, textDecoration: "underline" },
                      image: { maxWidth: "100%", height: "auto", borderRadius: "8px", margin: "8px 0 20px" },
                      blockQuote: {
                        borderLeft: "3px solid #e3e1df",
                        margin: "20px 0",
                        paddingLeft: "16px",
                        color: colors.muted,
                      },
                    }}
                  >
                    {markdown}
                  </Markdown>
                ) : (
                  paragraphs.map((paragraph, index) => (
                    <Text
                      key={`${index}-${paragraph}`}
                      style={{
                        fontFamily,
                        fontSize: "16px",
                        lineHeight: "27px",
                        margin: "0 0 20px",
                        color: colors.text,
                      }}
                    >
                      {paragraph}
                    </Text>
                  ))
                )}
              </Section>
              <Text
                style={{
                  fontFamily,
                  fontSize: "12px",
                  lineHeight: "20px",
                  color: colors.muted,
                  margin: "24px 0 0",
                }}
              >
                {footerText}{" "}
                <Link href={unsubscribeUrl} style={{ color: colors.muted, textDecoration: "underline" }}>
                  Click here to unsubscribe
                </Link>
              </Text>
              <Text
                style={{
                  fontFamily,
                  fontSize: "12px",
                  lineHeight: "20px",
                  color: colors.muted,
                  margin: "12px 0 0",
                }}
              >
                Have any comments about the article? Reply directly to this email and I’ll read them.
              </Text>
            </Section>
          </Container>
          <Corners bottom />
          {trackingPixelUrl && <Img src={trackingPixelUrl} width="1" height="1" alt="" style={{ border: 0 }} />}
        </Section>
      </Body>
    </Html>
  );
}
