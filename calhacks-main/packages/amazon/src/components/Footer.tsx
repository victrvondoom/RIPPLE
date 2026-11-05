import { FooterColumns, demoNotice, type FooterColumn } from "@calhacks/common";

const COLUMNS: FooterColumn[] = [
  { title: "Get to Know Us", links: ["Careers", "Blog", "About mzn", "Investor Relations", "mzn Devices", "mzn Science"] },
  { title: "Make Money with Us", links: ["Sell Products on mzn", "Sell on mzn Business", "Sell Apps on mzn", "Become an Affiliate", "Advertise Your Products", "Self-Publish with Us"] },
  { title: "mzn Payment Products", links: ["mzn Business Card", "Shop with Points", "Reload Your Balance", "mzn Currency Converter"] },
  { title: "Let Us Help You", links: ["Your Account", "Your Orders", "Shipping Rates & Policies", "Returns & Replacements", "Manage Your Content and Devices", "Help"] },
];

export default function Footer({ company }: { company: string }) {
  return (
    <footer>
      <a href="#top" className="footer-top">
        Back to Top
      </a>
      <div className="footer-links">
        <FooterColumns columns={COLUMNS} />
      </div>
      <div className="footer-bottom">
        <p>Conditions of Use &nbsp; Privacy Notice &nbsp; Consumer Health Data Privacy Disclosure &nbsp; Your Ads Privacy Choices</p>
        <p>© 1996-2026, {company} or its affiliates</p>
        <p className="footer-demo">{demoNotice("Amazon")}</p>
      </div>
    </footer>
  );
}
