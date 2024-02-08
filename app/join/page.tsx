import { Card } from "@/components/Card";
import SubscriptionPage from "./SubmitPage";

export const metadata = {
  title: "Subscribe",
  description: "Subscribe to Kunet News and",
};

export default function page() {

  return (
    <div>
      {/* <form method="post" action="https://mail.kualta.dev/subscription/form" className="listmonk-form">
        <Card>
          <div className="flex flex-row gap-2">
            <p>
              <input
                className="p-3 rounded-lg bg-primary dark:bg-dark-primary select-text accent-primary"
                type="email"
                name="email"
                required
                placeholder="Your E-mail"
              />
            </p>

            <p className="hidden">
              <input id="f15ba" type="checkbox" name="l" checked value="f15ba453-e799-435c-a580-290a7af956ae" />
              <label htmlFor="f15ba">Kunet News</label>
            </p>

            <p>
              <input
                className="bg-primary dark:bg-dark-primary hover:bg-secondary dark:hover:bg-dark-secondary p-3 rounded-lg"
                name="submit"
                type="submit"
                value="Subscribe"
              />
            </p>
          </div>
        </Card>
      </form> */}
      <SubscriptionPage />
    </div>
  );
}
