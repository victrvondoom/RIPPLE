export type FooterColumn = { title: string; links: string[] };

// Every store footer lists its links in titled columns.
export default function FooterColumns({ columns }: { columns: FooterColumn[] }) {
  return columns.map((column) => (
    <div key={column.title}>
      <h3>{column.title}</h3>
      <ul>
        {column.links.map((link) => (
          <li key={link}>{link}</li>
        ))}
      </ul>
    </div>
  ));
}
