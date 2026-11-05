import { FooterColumns, demoNotice, type FooterColumn } from "@calhacks/common";

const COLUMNS: FooterColumn[] = [
  { title: "dpp", links: ["About Us", "Careers", "Blog", "News", "Impact"] },
  { title: "Sell", links: ["Sell on dpp", "dpp Shipping", "dpp Affiliates", "Become a dpp Insider"] },
  { title: "Help", links: ["Help Center", "Safety Center", "dpp Status"] },
];

export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer-cols">
        <FooterColumns columns={COLUMNS} />
        <div>
          <h3>Download the dpp App</h3>
          <p>List faster, track your orders, and never miss a beat. On iOS and Android.</p>
        </div>
      </div>
      <div className="footer-bottom">
        <span>United States</span>
        <span>Sitemaps &nbsp; Terms and Conditions &nbsp; Privacy &nbsp; Cookies</span>
      </div>
      <p className="footer-demo">{demoNotice("Depop")}</p>
    </footer>
  );
}
