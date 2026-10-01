"""TCP echo and UDP/TCP DNS fixtures; no external services or DNS involved."""
import ipaddress
import socket
import struct
import sys
import threading


def dns_answer(query):
    end = 12
    while query[end]:
        end += query[end] + 1
    end += 1
    kind = struct.unpack('!H', query[end:end + 2])[0]
    question = query[12:end + 4]
    address = ipaddress.ip_address('10.42.0.10' if kind == 1 else 'fd42::10').packed
    return (query[:2] + struct.pack('!HHHHH', 0x8180, 1, 1, 0, 0) + question
            + b'\xc0\x0c' + struct.pack('!HHIH', kind, 1, 30, len(address)) + address)


def socket_for(host, kind):
    s = socket.socket(socket.AF_INET6 if ':' in host else socket.AF_INET, kind)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if ':' in host:
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    return s


def echo(host, port, tag):
    server = socket_for(host, socket.SOCK_STREAM)
    server.bind((host, port))
    server.listen()
    def handle(client):
        with client:
            while data := client.recv(65536):
                client.sendall(tag.encode() + data)
    while True:
        client, _ = server.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


def udp_dns(host):
    server = socket_for(host, socket.SOCK_DGRAM)
    server.bind((host, 53))
    while True:
        query, source = server.recvfrom(65535)
        server.sendto(dns_answer(query), source)


def tcp_dns(host):
    server = socket_for(host, socket.SOCK_STREAM)
    server.bind((host, 53))
    server.listen()
    def handle(client):
        with client:
            length = client.recv(2)
            if len(length) != 2:
                return
            size = struct.unpack('!H', length)[0]
            query = b''
            while len(query) < size:
                data = client.recv(size - len(query))
                if not data:
                    return
                query += data
            reply = dns_answer(query)
            client.sendall(struct.pack('!H', len(reply)) + reply)
    while True:
        client, _ = server.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


def udp_echo(host, port):
    server = socket_for(host, socket.SOCK_DGRAM)
    server.bind((host, port))
    while True:
        data, source = server.recvfrom(65535)
        server.sendto(data, source)


def bulk(host):
    import hashlib
    server = socket_for(host, socket.SOCK_STREAM)
    server.bind((host, 18083))
    server.listen()
    def handle(client):
        with client:
            digest = hashlib.sha256()
            while data := client.recv(65536):
                digest.update(data)
            client.sendall(digest.digest())
    while True:
        client, _ = server.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if sys.argv[1] == 'public':
    echo('198.51.100.10', 18081, 'public:')
else:
    for host in ['10.42.0.10', 'fd42::10']:
        threading.Thread(target=echo, args=(host, 18080, 'echo:'), daemon=True).start()
        threading.Thread(target=bulk, args=(host,), daemon=True).start()
        for port in (18080, 18084):
            threading.Thread(target=udp_echo, args=(host, port), daemon=True).start()
    for host in ['10.43.0.53', 'fd43::53']:
        threading.Thread(target=udp_dns, args=(host,), daemon=True).start()
        threading.Thread(target=tcp_dns, args=(host,), daemon=True).start()
    threading.Event().wait()
