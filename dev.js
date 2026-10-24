// Local run: the same API plus the static site, e.g. LOCAL_PGLITE=memory npm run dev
import express from 'express';
import { app } from './src/app.js';

const site = express();
site.use(app);
site.use(express.static(new URL('./public/', import.meta.url).pathname, { extensions: ['html'] }));
const port = Number(process.env.PORT || 3100);
site.listen(port, () => console.log(`CommentDrop cloud (local) → http://localhost:${port}`));
