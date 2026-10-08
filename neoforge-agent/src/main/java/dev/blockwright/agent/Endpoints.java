package dev.blockwright.agent;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;

final class Endpoints {
    private static final int ATTEMPTS = 60;

    private static final int CONNECT_TIMEOUT_MS = 1000;

    private static final long RETRY_DELAY_MS = 250L;

    private Endpoints() {
    }

    static Socket connectWithRetry(InetSocketAddress address)
            throws IOException, InterruptedException {
        IOException last = null;
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            Socket socket = new Socket();
            try {
                socket.connect(address, CONNECT_TIMEOUT_MS);
                socket.setTcpNoDelay(true);
                return socket;
            } catch (IOException error) {
                last = error;
                try {
                    socket.close();
                } catch (IOException ignored) {
                }
                Thread.sleep(RETRY_DELAY_MS);
            }
        }
        throw last == null ? new IOException("failed to connect") : last;
    }

    static InetSocketAddress parseEndpoint(String endpoint) {
        int separator = endpoint.lastIndexOf(':');
        if (separator <= 0 || separator == endpoint.length() - 1) {
            return null;
        }
        try {
            String host = endpoint.substring(0, separator);
            int port = Integer.parseInt(endpoint.substring(separator + 1));
            return new InetSocketAddress(host, port);
        } catch (NumberFormatException error) {
            return null;
        }
    }

    static String setting(String property, String env, String fallback) {
        String value = System.getProperty(property);
        if (value == null || value.isBlank()) {
            value = System.getenv(env);
        }
        return value == null || value.isBlank() ? fallback : value;
    }
}
