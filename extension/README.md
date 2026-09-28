# ChatGPT Canvas — Extensión Chrome

Transforma el chat de ChatGPT en un **dashboard visual** con bloques interconectados, bifurcaciones de conversación y herramientas de anotación.

---

## Instalación (modo desarrollador)

### 1. Descargar el repositorio
Descarga el ZIP de la rama que quieras instalar y descomprímelo, o clona el repositorio. La carpeta `extension/` ya incluye los archivos y los iconos necesarios. No necesitas Node.js ni instalar dependencias para usar la extensión.

### 2. Cargar en Chrome
1. Abre Chrome y ve a `chrome://extensions`.
2. Activa **Modo de desarrollador**.
3. Haz clic en **Cargar extensión sin empaquetar**.
4. Selecciona la carpeta `extension/`.

### 3. Actualizar una instalación existente
1. Sustituye el contenido de la carpeta `extension/` que ya tienes cargada por el de la nueva versión, incluyendo `conversation.js`.
2. En `chrome://extensions`, pulsa **Recargar** en la tarjeta de ChatGPT Canvas. La versión debe ser **1.0.2**.
3. Recarga también la pestaña de ChatGPT para que se carguen los nuevos scripts.
4. Activa el canvas. Las posiciones, notas y anotaciones existentes se recuperan del almacenamiento de la misma extensión.

### 4. Usar la extensión
1. Ve a [chatgpt.com](https://chatgpt.com) o [chat.openai.com](https://chat.openai.com)
2. Abre el popup de la extensión (icono ⬡ en la barra)
3. Activa el toggle **"Canvas activo"**
4. El canvas reemplaza la zona central de mensajes

---

## Estructura de archivos

```
extension/
├── manifest.json       — Configuración de la extensión
├── conversation.js     — Adaptador DOM: detección por roles y contenido seguro
├── content.js          — Núcleo: canvas, bloques, bifurcaciones
├── styles.css          — Estilos del dashboard
├── popup.html          — UI del popup
├── popup.js            — Lógica del popup
├── fabric.min.js       — Archivo incluido en el repositorio
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Funcionalidades

### Bloques de conversación
- Cada mensaje del usuario = **título** del bloque
- Respuesta de ChatGPT = **contenido** del bloque
- **Minimizable** (botón ─), **redimensionable** (esquina inferior derecha), **reposicionable** (arrastrar por el header)

### Bifurcaciones
- Botón **`+`** en cada bloque → marca ese bloque como punto de bifurcación
- El siguiente mensaje que envíes crea un **bloque hijo** conectado con una línea curva
- Se visualiza el árbol completo de conversaciones ramificadas

### Herramientas del canvas
| Herramienta | Función |
|---|---|
| ↖ Seleccionar | Mover bloques, hacer pan del canvas |
| 🖊 Resaltador | Selecciona texto dentro de un bloque para resaltarlo en amarillo |
| U̲ Subrayar | Selecciona texto para subrayarlo |
| T Texto | Clic en el canvas para crear una nota adhesiva |
| ✏ Dibujo | Dibuja libremente sobre el canvas |
| + / − | Zoom in / out |
| ⊡ Ajustar | Centra la vista en los bloques |
| ↻ Detectar | Vuelve a leer los mensajes montados en la página |

### Persistencia
- El estado se guarda automáticamente con `chrome.storage.local`
- Al reabrir un chat, el canvas se restaura tal como lo dejaste
- Exporta todos los datos a JSON desde el popup

---

## Notas técnicas

- **Sin coste de API**: la extensión solo lee el DOM de ChatGPT e intercepta la UI
- **No modifica el sidebar izquierdo** (historial, carpetas) ni la **barra de input** inferior
- Compatible con el selector de modelo de ChatGPT en la barra superior
- Detecta navegación SPA (cambio de chat) y actualiza el canvas automáticamente

---

## Limitaciones conocidas

- ChatGPT no ofrece un contrato público para su DOM. El adaptador `conversation.js` admite atributos de autor, `data-turn`, test IDs de mensaje y los artículos antiguos. Puede requerir nuevos ajustes si estos marcadores cambian.
- Solo se importan mensajes presentes en el DOM. Si ChatGPT monta una parte de un chat largo, los bloques ya capturados se conservan, pero la extensión no descarga el historial que no está montado.
- Se conservan párrafos, listas, enlaces, tablas y código. Imágenes y componentes interactivos se representan mediante el texto disponible; no se replica su interfaz.
- Un bloque con resaltados o subrayados conserva su HTML anotado, incluso si después se regenera la respuesta. Esto evita perder las anotaciones existentes.
- Las bifurcaciones de chats importados (anteriores a activar el canvas) se muestran como árbol lineal; solo las bifurcaciones nuevas crean ramas reales
- El dibujo libre no persiste entre sesiones (limitación del canvas HTML5 sin serialización adicional)


## Corrección 1.0.2 y validación

La lectura agrupa los mensajes por autor y orden del documento, observa cambios de texto durante el streaming y sincroniza los canvas guardados al abrirlos. Los IDs de mensaje evitan actualizar un bloque distinto cuando ChatGPT desmonta turnos anteriores. Las mutaciones creadas por el propio canvas no generan nuevas lecturas.

La respuesta se reconstruye con una lista limitada de etiquetas HTML, sin scripts, estilos, controles, atributos de evento ni enlaces ejecutables. Los bloques tienen scroll propio y permiten resaltar selecciones que atraviesan texto con formato.

Desde la raíz del repositorio, con una versión de Node.js compatible con `package.json`:

```sh
npm ci
npm test
npm run check
```

Las pruebas usan DOMs simulados con jsdom; no sustituyen la comprobación en una sesión real de ChatGPT. Cubren agrupación, fragmentos múltiples, streaming, hidratación tardía, formato, migración, notas, anotaciones, remontaje y navegación entre chats.

Para una revisión visual local:

```sh
python -m http.server 8765
```

Abre `http://localhost:8765/tests/preview.html`. Es una conversación ficticia sin llamadas de red a ChatGPT y con almacenamiento en memoria.

En una sesión real, comprueba una conversación existente, envía una respuesta nueva, prueba la rueda dentro de un bloque y vuelve a otro chat. Si no aparecen mensajes, usa **↻**. La validación del DOM autenticado de ChatGPT queda pendiente de esa comprobación manual.
