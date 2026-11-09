import { useParams } from 'react-router-dom';

export default function ReaderPage() {
  const { bookId } = useParams();
  return (
    <section className="page">
      <h1>Reader</h1>
      <p className="todo">TODO: owned by src/reader</p>
      {bookId ? <p className="muted">book: {bookId}</p> : null}
    </section>
  );
}
