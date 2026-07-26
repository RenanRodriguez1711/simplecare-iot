# Deploy — Cómo replicar el servidor desde cero

Guía completa para instalar el sistema SimpleCare IoT en un VPS nuevo con Ubuntu.

---

## Requisitos

- VPS Ubuntu (20.04 o superior)
- Mínimo 1 GB RAM, 10 GB disco
- Acceso SSH como root
- Puerto 5187 abierto para los dispositivos EV07B
- Dominio o IP pública

---

## 1. Actualizar el sistema

```bash
apt update && apt upgrade -y
```

---

## 2. Instalar Docker

```bash
apt install -y docker.io
systemctl enable docker
systemctl start docker
```

---

## 3. Instalar Traccar

```bash
docker pull traccar/traccar:latest

docker run -d \
  --name traccar \
  --restart always \
  -p 8082:8082 \
  -p 5187:5187 \
  -v /opt/traccar/logs:/opt/traccar/logs \
  -v /opt/traccar/data:/opt/traccar/data \
  traccar/traccar:latest
```

Verificar que corre:
```bash
docker ps | grep traccar
```

Panel disponible en: `http://<IP>:8082`  
Usuario por defecto: `admin` / Contraseña: `admin` — **cambiar inmediatamente**

---

## 4. Instalar Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs
node --version  # debe mostrar v18.x
```

---

## 5. Instalar dependencias de compilación (para better-sqlite3)

```bash
apt install -y build-essential python3
```

---

## 6. Crear la carpeta de la aplicación

```bash
mkdir -p /opt/simplecare/public/logos
cd /opt/simplecare
```

---

## 7. Instalar dependencias Node

```bash
cd /opt/simplecare
npm init -y
npm install express better-sqlite3
```

---

## 8. Copiar server.js y dashboard.html

Copiar desde este repositorio (carpeta `server/`) al VPS:

```bash
scp server/server.js root@<IP>:/opt/simplecare/
scp server/public/dashboard.html root@<IP>:/opt/simplecare/public/
```

O editar directamente en el VPS con `nano /opt/simplecare/server.js`.

---

## 9. Instalar PM2

```bash
npm install -g pm2
cd /opt/simplecare
pm2 start server.js --name simplecare
pm2 startup
pm2 save
```

Verificar:
```bash
pm2 status
```

---

## 10. Configurar UFW (firewall)

```bash
ufw allow 22/tcp        # SSH
ufw allow 5187/tcp      # Traccar — dispositivos
ufw allow 8082/tcp      # Traccar — panel web
ufw allow 3000/tcp      # Node.js — dashboard
ufw allow from 172.17.0.0/16 to any port 3000  # Docker → host
ufw enable
ufw status
```

---

## 11. Configurar Traccar (webhook + WhatsApp)

Crear el script de configuración:

```bash
nano /root/write_config.py
```

Contenido (reemplazar los valores de token y phoneNumberId):

```python
xml = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE properties SYSTEM 'http://java.sun.com/dtd/properties.dtd'>
<properties>
    <entry key='database.driver'>org.h2.Driver</entry>
    <entry key='database.url'>jdbc:h2:./data/database</entry>
    <entry key='database.user'>sa</entry>
    <entry key='database.password'></entry>
    <entry key='notificator.types'>web,mail,whatsapp</entry>
    <entry key='notificator.whatsapp.token'>TOKEN_META_AQUI</entry>
    <entry key='notificator.whatsapp.phoneNumberId'>PHONE_NUMBER_ID_AQUI</entry>
    <entry key='notificator.whatsapp.templateName'>simplecare_test2</entry>
    <entry key='notificator.whatsapp.templateLanguage'>es</entry>
    <entry key='event.forward.url'>http://172.17.0.1:3000/webhook</entry>
    <entry key='event.forward.type'>json</entry>
</properties>"""
open('/root/traccar.xml','w').write(xml)
print('OK')
```

Aplicar:
```bash
python3 /root/write_config.py
docker cp /root/traccar.xml traccar:/opt/traccar/conf/traccar.xml
docker restart traccar
```

**Por qué Python y no bash:** el carácter `!` del token WhatsApp se expande incorrectamente en bash heredoc y corrompe el XML.

---

## 12. Registrar un dispositivo en Traccar

1. Abrir panel Traccar: `http://<IP>:8082`
2. Ir a Dispositivos → `+` Agregar
3. Nombre: nombre de la persona (ej: "Miguel")
4. Identificador: IMEI del dispositivo EV07B
5. Guardar
6. Ir a Notificaciones → crear notificación de tipo "Alarma" → asignar al dispositivo → canal WhatsApp
7. En el campo "Número de teléfono": número del contacto con código país (ej: `56912345678`)

---

## 13. Verificar el flujo completo

```bash
# Ver logs en tiempo real
pm2 logs simplecare

# En otra terminal, simular un webhook
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"event":{"type":"alarm","deviceId":1,"attributes":{"alarm":"sos"}},"position":{"latitude":-33.45,"longitude":-70.65}}'
```

Abrir el dashboard: `http://<IP>:3000/dashboard`

---

## 14. (Opcional) Configurar HTTPS con Nginx

Ver `SEGURIDAD.md` para los pasos de Nginx + Certbot.  
Requiere un dominio apuntando a la IP del VPS.
