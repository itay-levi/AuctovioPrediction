import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function Index() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <div className={styles.logo}>⚗️</div>
        <h1 className={styles.heading}>Auctovio — AI Customer Panel</h1>
        <p className={styles.text}>
          Run instant AI customer panels that reveal exactly why shoppers
          abandon your product pages — and what to fix first.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Your Shopify store domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="your-store.myshopify.com"
                autoComplete="off"
              />
            </label>
            <button className={styles.button} type="submit">
              Install app →
            </button>
          </Form>
        )}

        <ul className={styles.list}>
          <li>
            <strong>5-agent AI customer panel.</strong> Realistic personas
            stress-test your listing from first impression to checkout.
          </li>
          <li>
            <strong>Friction breakdown by category.</strong> See exactly where
            price, trust, or logistics are blocking conversion.
          </li>
          <li>
            <strong>One-click action plan.</strong> Ranked fixes with AI-written
            policy copy you can paste directly into your store.
          </li>
        </ul>
      </div>
    </div>
  );
}
