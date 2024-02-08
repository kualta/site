"use client";
import { Card } from "@/components/Card";

const SubscriptionPage = () => {
  const handleSubmit = (event: any) => {
    event.preventDefault();

    console.log(event.target.email.value)
    fetch(`/api/subscribe?email=${event.target.email.value}`, {
      method: "POST",
    })
      .then((res) => res.json())
      .then((data) => {
        console.log(data);
      });
  };
  return (
    <form onSubmit={handleSubmit} className="listmonk-form">
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
    </form>
  );
};

export default SubscriptionPage;
