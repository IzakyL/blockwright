package dev.blockwright.agent;

import javax.tools.FileObject;
import javax.tools.ForwardingJavaFileManager;
import javax.tools.JavaFileManager;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardLocation;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

final class SnippetFileManager extends ForwardingJavaFileManager<JavaFileManager> {
    private final SnippetModules.Index index;

    SnippetFileManager(JavaFileManager delegate, SnippetModules.Index index) {
        super(delegate);
        this.index = index;
    }

    @Override
    public Iterable<JavaFileObject> list(
        Location location, String packageName, Set<JavaFileObject.Kind> kinds, boolean recurse) throws IOException {
        Iterable<JavaFileObject> delegated = super.list(location, packageName, kinds, recurse);
        if (location != StandardLocation.CLASS_PATH
            || !kinds.contains(JavaFileObject.Kind.CLASS)
            || index.packageCount() == 0) {
            return delegated;
        }
        List<JavaFileObject> merged = new ArrayList<>();
        Set<String> taken = new LinkedHashSet<>();
        for (JavaFileObject file : delegated) {
            merged.add(file);
            String binaryName = binaryNameOf(location, file);
            if (binaryName != null) {
                taken.add(binaryName);
            }
        }
        for (SnippetModules.Entry entry : index.classes(packageName, recurse)) {
            if (taken.add(entry.binaryName())) {
                merged.add(new ModuleClass(entry));
            }
        }
        return merged;
    }

    @Override
    public String inferBinaryName(Location location, JavaFileObject file) {
        if (file instanceof ModuleClass module) {
            return module.binaryName();
        }
        return super.inferBinaryName(location, file);
    }

    @Override
    public boolean hasLocation(Location location) {
        if (location == StandardLocation.CLASS_PATH && index.packageCount() > 0) {
            return true;
        }
        return super.hasLocation(location);
    }

    @Override
    public boolean isSameFile(FileObject first, FileObject second) {
        if (first instanceof ModuleClass || second instanceof ModuleClass) {
            return first.toUri().equals(second.toUri());
        }
        return super.isSameFile(first, second);
    }

    @Override
    public boolean contains(Location location, FileObject file) throws IOException {
        if (file instanceof ModuleClass) {
            return location == StandardLocation.CLASS_PATH;
        }
        return super.contains(location, file);
    }

    private String binaryNameOf(Location location, JavaFileObject file) {
        try {
            return super.inferBinaryName(location, file);
        } catch (IllegalArgumentException unknown) {
            return null;
        }
    }

    static final class ModuleClass extends SimpleJavaFileObject {
        private final SnippetModules.Entry entry;

        ModuleClass(SnippetModules.Entry entry) {
            super(uri(entry), Kind.CLASS);
            this.entry = entry;
        }

        private static URI uri(SnippetModules.Entry entry) {
            return URI.create("blockwright-module:///" + entry.moduleName() + "/" + entry.resourceName());
        }

        String binaryName() {
            return entry.binaryName();
        }

        @Override
        public InputStream openInputStream() throws IOException {
            return new ByteArrayInputStream(entry.read());
        }

        @Override
        public String getName() {
            return entry.moduleName() + "/" + entry.resourceName();
        }

        @Override
        public long getLastModified() {
            return 0L;
        }

        @Override
        public boolean isNameCompatible(String simpleName, Kind kind) {
            if (kind != Kind.CLASS) {
                return false;
            }
            String binaryName = entry.binaryName();
            int dot = binaryName.lastIndexOf('.');
            return binaryName.substring(dot + 1).equals(simpleName);
        }
    }
}
